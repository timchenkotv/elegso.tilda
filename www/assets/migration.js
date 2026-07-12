
function migrationHydrateImages() {
  document.querySelectorAll('img[data-original]').forEach((image) => {
    const source = image.getAttribute('data-original');
    if (source) image.src = source;
  });
  document.querySelectorAll('[data-original]:not(img)').forEach((element) => {
    const source = element.getAttribute('data-original');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
  document.querySelectorAll('[data-content-cover-bg]').forEach((element) => {
    const source = element.getAttribute('data-content-cover-bg');
    if (source) element.style.backgroundImage = 'url("' + source + '")';
  });
}
window.t_lazyload_update = migrationHydrateImages;
document.addEventListener('DOMContentLoaded', () => {
  migrationHydrateImages();
  document.querySelectorAll('form').forEach((form) => {
    form.setAttribute('data-migration-form', 'disabled');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.alert('Форма временно не отправляет заявки. Пожалуйста, позвоните или напишите нам.');
    }, true);
  });
});
