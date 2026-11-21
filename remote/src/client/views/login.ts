import { tr } from "../i18n";
import { themeToggleMarkup } from "../icons";
import { bindThemeToggleButtons } from "../theme";
import { api } from "../transport";

export function renderLogin(app: HTMLElement, onSuccess: () => void): void {
  app.innerHTML = `
    <section class="shell auth-shell" aria-labelledby="login-title">
      <div class="panel auth-panel">
        <header class="auth-header">
          <div class="brand auth-brand">WispTerm Remote</div>
          ${themeToggleMarkup()}
          <h1 id="login-title">${tr("Sign in", "登录")}</h1>
        </header>
        <form class="auth-form" id="login-form" novalidate>
          <label>
            ${tr("Username", "用户名")}
            <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="login-feedback" required />
          </label>
          <label>
            ${tr("Password", "密码")}
            <input name="password" type="password" autocomplete="current-password" aria-describedby="login-feedback" required />
          </label>
          <div class="auth-action">
            <button type="submit">${tr("Sign in", "登录")}</button>
            <output class="form-message" id="login-feedback" aria-live="polite"></output>
          </div>
        </form>
      </div>
    </section>
  `;

  const form = app.querySelector<HTMLFormElement>("#login-form");
  const username = form?.querySelector<HTMLInputElement>('[name="username"]');
  const password = form?.querySelector<HTMLInputElement>('[name="password"]');
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const feedback = form?.querySelector<HTMLOutputElement>("#login-feedback");
  if (!form || !username || !password || !submit || !feedback) return;

  const clearFeedback = (): void => {
    feedback.textContent = "";
    username.removeAttribute("aria-invalid");
    password.removeAttribute("aria-invalid");
  };

  form.addEventListener("input", clearFeedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    clearFeedback();
    const missing = !username.value.trim() ? username : !password.value ? password : null;
    if (missing) {
      feedback.textContent = missing === username ? tr("Enter your username", "请输入用户名") : tr("Enter your password", "请输入密码");
      missing.setAttribute("aria-invalid", "true");
      missing.focus();
      return;
    }

    const submitHadFocus = document.activeElement === submit;
    const credentials = { username: username.value, password: password.value };
    submit.disabled = true;
    submit.textContent = tr("Signing in…", "登录中…");
    form.setAttribute("aria-busy", "true");

    let response: Response | undefined;
    try {
      response = await api("/api/login", { method: "POST", body: JSON.stringify(credentials) });
    } catch {
      feedback.textContent = tr("Could not reach the relay. Try again.", "连接中继失败，请重试");
    } finally {
      submit.disabled = false;
      submit.textContent = tr("Sign in", "登录");
      form.removeAttribute("aria-busy");
    }

    if (response?.ok) {
      if (form.isConnected) onSuccess();
      return;
    }

    if (response?.status === 401) {
      feedback.textContent = tr("Incorrect username or password", "用户名或密码不正确");
      if (username.value === credentials.username && password.value === credentials.password) {
        username.setAttribute("aria-invalid", "true");
        password.setAttribute("aria-invalid", "true");
      }
    } else if (response) {
      feedback.textContent = tr("Sign-in failed. Try again shortly.", "登录失败，请稍后重试");
    }
    if (submitHadFocus && document.activeElement === document.body) submit.focus();
  });

  bindThemeToggleButtons();
}
