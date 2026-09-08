const scrollButtons = document.querySelectorAll('[data-scroll-target]');

scrollButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.scrollTarget;
    const target = document.getElementById(targetId);

    if (!target) {
      console.warn(`Scroll target not found: #${targetId}`);
      return;
    }

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  });
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    });
  },
  { threshold: 0.11 }
);

document.querySelectorAll('.reveal').forEach((element) => {
  revealObserver.observe(element);
});

const navLinks = document.querySelectorAll('.links a');
const sections = [...document.querySelectorAll('main section[id]')];

const navObserver = new IntersectionObserver(
  (entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;

    navLinks.forEach((link) => {
      link.classList.toggle(
        'active',
        link.getAttribute('href') === `#${visible.target.id}`
      );
    });
  },
  { rootMargin: '-35% 0px -55% 0px', threshold: 0 }
);

sections.forEach((section) => navObserver.observe(section));