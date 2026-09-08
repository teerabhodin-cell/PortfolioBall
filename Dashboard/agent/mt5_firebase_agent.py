import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import firebase_admin
import MetaTrader5 as mt5
from dotenv import load_dotenv
from firebase_admin import credentials, firestore

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

PORTFOLIO_ID = os.environ["PORTFOLIO_ID"]
SERVICE_ACCOUNT_FILE = BASE_DIR / os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE", "serviceAccountKey.json")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "10"))
EQUITY_HISTORY_SECONDS = int(os.getenv("EQUITY_HISTORY_SECONDS", "60"))
POSITION_PROFIT_CHANGE_THRESHOLD = float(os.getenv("POSITION_PROFIT_CHANGE_THRESHOLD", "0.50"))
MT5_PATH = os.getenv("MT5_PATH") or None
PUBLIC_SHOW_VOLUME = os.getenv("PUBLIC_SHOW_VOLUME", "true").lower() == "true"

if not SERVICE_ACCOUNT_FILE.exists():
    raise FileNotFoundError(f"Firebase service-account JSON not found: {SERVICE_ACCOUNT_FILE}")

firebase_admin.initialize_app(credentials.Certificate(str(SERVICE_ACCOUNT_FILE)))
db = firestore.client()

last_history_at = 0.0
last_public_hash = None
last_status = None
sequence = 0


def utc_now():
    return datetime.now(timezone.utc)


def iso_now():
    return utc_now().isoformat().replace("+00:00", "Z")


def finite_number(value, fallback=0.0):
    try:
        value = float(value)
        return value if value == value and value not in (float("inf"), float("-inf")) else fallback
    except (TypeError, ValueError):
        return fallback


def mt5_time(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def serialize_account(account):
    return {
        "login": str(account.login),
        "server": account.server or "",
        "company": account.company or "",
        "currency": account.currency or "",
        "balance": finite_number(account.balance),
        "equity": finite_number(account.equity),
        "margin": finite_number(account.margin),
        "freeMargin": finite_number(account.margin_free),
        "marginLevel": finite_number(account.margin_level),
        "profit": finite_number(account.profit),
        "leverage": int(account.leverage),
    }


def serialize_positions(positions):
    public_positions = []
    for position in positions or []:
        item = {
            "ticket": str(position.ticket),
            "symbol": position.symbol,
            "side": "BUY" if position.type == mt5.POSITION_TYPE_BUY else "SELL",
            "openPrice": finite_number(position.price_open),
            "currentPrice": finite_number(position.price_current),
            "profit": finite_number(position.profit),
            "openedAt": mt5_time(position.time),
        }
        if PUBLIC_SHOW_VOLUME:
            item["volume"] = finite_number(position.volume)
        public_positions.append(item)
    return public_positions


def normalized_snapshot(account, positions, orders):
    global sequence
    sequence += 1
    return {
        "schemaVersion": 1,
        "portfolioId": PORTFOLIO_ID,
        "sequence": sequence,
        "capturedAt": iso_now(),
        "status": "LIVE",
        "pendingOrders": len(orders or []),
        "account": serialize_account(account),
        "positions": serialize_positions(positions),
    }


def stable_hash(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_public_event(event_type, message, severity="info"):
    event_id = str(uuid.uuid4())
    db.collection("portfolios").document(PORTFOLIO_ID).collection("public").document("events").collection(event_id).document("data").set({
        "eventId": event_id,
        "type": event_type,
        "message": message,
        "severity": severity,
        "occurredAt": firestore.SERVER_TIMESTAMP,
    })


def update_portfolio_status(status_value):
    db.collection("portfolios").document(PORTFOLIO_ID).set({
        "status": status_value,
        "lastSeenAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)


def write_snapshot(snapshot):
    global last_public_hash, last_history_at
    portfolio_ref = db.collection("portfolios").document(PORTFOLIO_ID)
    public_ref = portfolio_ref.collection("public")
    payload_hash = stable_hash(snapshot)

    # One latest document every 10 seconds. It contains only explicitly public-safe data.
    public_ref.document("account").set(snapshot)

    now = time.time()
    if now - last_history_at >= EQUITY_HISTORY_SECONDS:
        minute_key = utc_now().strftime("%Y%m%d%H%M")
        public_ref.document("equityHistory").collection(minute_key).document("data").set({
            "capturedAt": firestore.SERVER_TIMESTAMP,
            "balance": snapshot["account"]["balance"],
            "equity": snapshot["account"]["equity"],
            "profit": snapshot["account"]["profit"],
        })
        last_history_at = now

    update_portfolio_status("LIVE")
    last_public_hash = payload_hash


def initialize_mt5():
    result = mt5.initialize(path=MT5_PATH) if MT5_PATH else mt5.initialize()
    if not result:
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")


def main():
    global last_status
    print(f"Starting Firebase monitoring agent for portfolio: {PORTFOLIO_ID}")
    print(f"Poll interval: {POLL_SECONDS}s | Equity history: {EQUITY_HISTORY_SECONDS}s")
    initialize_mt5()
    try:
        write_public_event("AgentStarted", "Monitoring agent started in public read-only mode.")
        while True:
            account = mt5.account_info()
            if account is None:
                message = f"MT5 account_info failed: {mt5.last_error()}"
                print(message)
                if last_status != "OFFLINE":
                    update_portfolio_status("OFFLINE")
                    write_public_event("AgentOffline", "Monitoring agent cannot read the MT5 account.", "warning")
                    last_status = "OFFLINE"
                time.sleep(POLL_SECONDS)
                continue

            positions = mt5.positions_get()
            orders = mt5.orders_get()
            snapshot = normalized_snapshot(account, positions, orders)
            write_snapshot(snapshot)

            if last_status != "LIVE":
                write_public_event("AgentLive", "Monitoring agent connected and is publishing public snapshots.")
                last_status = "LIVE"

            print(f"[{snapshot['capturedAt']}] sent sequence={snapshot['sequence']} positions={len(snapshot['positions'])} equity={snapshot['account']['equity']}")
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print("Stopping monitoring agent.")
    except Exception as exc:
        print(f"Fatal agent error: {exc}")
        try:
            update_portfolio_status("OFFLINE")
            write_public_event("AgentError", "Monitoring agent stopped because of an internal error.", "error")
        except Exception:
            pass
        raise
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
