import '@phosphor-icons/web/regular';
import './style.css';

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = button.dataset.copy;
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    const original = button.innerHTML;
    button.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i><span>Copied</span>';
    window.setTimeout(() => { button.innerHTML = original; }, 1600);
  });
});
