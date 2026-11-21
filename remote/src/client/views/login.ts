import { tr } from "../i18n";
import { themeToggleMarkup } from "../icons";
import { bindThemeToggleButtons } from "../theme";
import { api } from "../transport";
import { escapeText } from "../utils";
import { remoteBrandMarkup } from "../version";

export function renderLogin(app: HTMLElement, onSuccess: () => void, message = ""): void {
  app.innerHTML = `
    <section class="shell auth-shell">
      ${themeToggleMarkup("theme-toggle-floating")}
      <form class="panel auth-panel" id="login-form">
        <h1>${tr("Sign in", "登录")}</h1>
        <label>
          ${tr("Username", "用户名")}
          <input name="username" autocomplete="username" required />
        </label>
        <label>
          ${tr("Password", "密码")}
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit">${tr("Sign in", "登录")}</button>
        <output class="form-message">${escapeText(message)}</output>
      </form>
      <footer class="brand auth-brand-footer">${remoteBrandMarkup()}</footer>
    </section>
  `;

  const form = document.querySelector<HTMLFormElement>("#login-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const res = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
      }),
    });
    if (!res.ok) {
      renderLogin(app, onSuccess, res.status === 401 ? tr("Incorrect username or password", "用户名或密码不正确") : tr("Sign-in failed. Please try again", "登录失败，请稍后重试"));
      return;
    }
    onSuccess();
  });

  bindThemeToggleButtons();
}
