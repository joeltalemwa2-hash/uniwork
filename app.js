async function uniworkApi(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}
window.uniworkApi = uniworkApi;
window.uniworkSetSession = user => {
  window.uniworkUser = user;
  document.querySelectorAll("[data-account-link]").forEach(link => {
    if (link.dataset.accountLink === "admin") {
      const isAdmin = user && user.role === "admin";
      link.hidden = !isAdmin;
      link.href = "/account.html#dashboard";
      link.setAttribute("aria-label", "Manage listings");
      link.title = "Manage listings";
      return;
    }
    link.href = user ? "/account.html#dashboard" : "/account.html";
    link.textContent = user ? (user.role === "admin" ? "Manage listings" : "My account") : "Log in";
  });
  window.dispatchEvent(new CustomEvent("uniwork:session", { detail: user }));
};
window.uniworkSessionReady = uniworkApi("/api/session").then(({ user }) => {
  window.uniworkSetSession(user);
  return user;
}).catch(() => null);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(error => console.warn("Offline support could not start.", error)));
}
