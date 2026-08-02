const form = document.querySelector('form');
const errorBox = document.getElementById('formError');

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'جارٍ التنفيذ...';
  try {
    const endpoint = form.id === 'signupForm' ? '/api/auth/signup' : '/api/auth/login';
    const payload = Object.fromEntries(new FormData(form).entries());
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر إكمال العملية');
    window.location.href = data.redirect || '/app';
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});
