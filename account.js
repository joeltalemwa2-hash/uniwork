const accountApi = window.uniworkApi;
const statusBox = document.getElementById("account-status");
const dashboardStatus = document.getElementById("dashboard-status");
const authView = document.getElementById("auth-view");
const dashboard = document.getElementById("dashboard");

function showStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}
function setMode(mode) {
  const loginMode = mode !== "register";
  document.getElementById("login-form").classList.toggle("hidden", !loginMode);
  document.getElementById("register-form").classList.toggle("hidden", loginMode);
  document.getElementById("login-tab").setAttribute("aria-selected", String(loginMode));
  document.getElementById("register-tab").setAttribute("aria-selected", String(!loginMode));
  showStatus(statusBox, "");
}
document.getElementById("login-tab").addEventListener("click", () => setMode("login"));
document.getElementById("register-tab").addEventListener("click", () => setMode("register"));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function jobRow(job, extra = "") {
  return `<article class="data-row"><div><h4>${escapeHtml(job.title)}</h4><p>${escapeHtml(job.company)} · ${escapeHtml(job.location)} · ${escapeHtml(job.type)}</p><span class="badge">${escapeHtml(job.status || (job.isSample ? "sample" : "active"))}</span></div>${extra}</article>`;
}
async function loadStudentData() {
  const { applications } = await accountApi("/api/student/applications");
  const target = document.getElementById("application-list");
  target.innerHTML = applications.length ? applications.map(application => jobRow({ title: application.title, company: application.company, location: application.location, type: application.status, status: application.status })).join("") : '<p class="empty">Your applications will appear here.</p>';
}
async function loadEmployerData() {
  const [{ jobs }, { applications }] = await Promise.all([accountApi("/api/employer/jobs"), accountApi("/api/employer/applications")]);
  const target = document.getElementById("employer-list");
  target.innerHTML = jobs.length ? jobs.map(job => jobRow(job, job.status === "pending" ? `<button class="button button-small" type="button" data-delete-job="${job.id}">Remove draft</button>` : "")).join("") : '<p class="empty">You have not submitted a role yet.</p>';
  const applicationTarget = document.getElementById("received-application-list");
  applicationTarget.innerHTML = applications.length ? applications.map(application => `<article class="data-row"><div><h4>${escapeHtml(application.student_name)} · ${escapeHtml(application.title)}</h4><p><a href="mailto:${encodeURIComponent(application.student_email)}">${escapeHtml(application.student_email)}</a> · Received ${escapeHtml(new Date(application.created_at).toLocaleDateString())}</p><p>${escapeHtml(application.message || "No message included.")}</p><span class="badge">${escapeHtml(application.status)}</span></div><div><button class="button button-small" type="button" data-update-application="${application.id}" data-status="reviewing">Reviewing</button> <button class="button button-small" type="button" data-update-application="${application.id}" data-status="accepted">Accept</button> <button class="button button-small" type="button" data-update-application="${application.id}" data-status="declined">Decline</button></div></article>`).join("") : '<p class="empty">Applications to your active roles will appear here.</p>';
}
async function loadAdminData() {
  const [{ jobs }, { users }, { content }] = await Promise.all([accountApi("/api/admin/jobs?status=pending"), accountApi("/api/admin/users"), accountApi("/api/content")]);
  document.getElementById("site-title").value = content.home_title || "";
  document.getElementById("site-description").value = content.home_description || "";
  document.getElementById("moderation-list").innerHTML = jobs.length ? jobs.map(job => jobRow(job, `<div><button class="button button-small" type="button" data-set-job="${job.id}" data-status="active">Approve</button> <button class="button button-small" type="button" data-set-job="${job.id}" data-status="rejected">Reject</button></div>`)).join("") : '<p class="empty">There are no listings awaiting review.</p>';
  document.getElementById("user-list").innerHTML = users.length ? users.map(user => `<article class="data-row"><div><h4>${escapeHtml(user.name)}</h4><p>${escapeHtml(user.email)}</p><span class="badge">${escapeHtml(user.role)}</span></div></article>`).join("") : '<p class="empty">No accounts yet.</p>';
}
async function openDashboard(user) {
  authView.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.getElementById("account-role").textContent = `${user.role} account`;
  document.getElementById("dashboard-title").textContent = `Welcome, ${user.name.split(" ")[0]}.`;
  document.getElementById("account-identity").textContent = user.email;
  document.getElementById("student-panel").classList.toggle("hidden", user.role !== "student");
  document.getElementById("employer-panel").classList.toggle("hidden", user.role !== "employer");
  document.getElementById("admin-panel").classList.toggle("hidden", user.role !== "admin");
  try {
    if (user.role === "student") await loadStudentData();
    if (user.role === "employer") await loadEmployerData();
    if (user.role === "admin") await loadAdminData();
  } catch (error) {
    showStatus(dashboardStatus, error.message, "error");
  }
}

const requestedMode = new URLSearchParams(location.search).get("mode");
if (requestedMode === "register") setMode("register");
const nextPath = new URLSearchParams(location.search).get("next");
const safeNextPath = nextPath && nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "";
window.uniworkSessionReady.then(async user => {
  if (user) return openDashboard(user);
  const { needsSetup } = await accountApi("/api/admin/setup-needed");
  if (needsSetup) {
    document.getElementById("regular-auth").classList.add("hidden");
    document.getElementById("owner-setup").classList.remove("hidden");
  } else if (requestedMode === "register") setMode("register");
}).catch(() => showStatus(statusBox, "Could not connect to the account service. Start or refresh the UniWork server.", "error"));

document.getElementById("owner-setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showStatus(statusBox, "Creating your owner account…");
  try {
    const result = await accountApi("/api/admin/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    window.uniworkSetSession(result.user);
    await openDashboard(result.user);
  } catch (error) {
    showStatus(statusBox, error.message, "error");
  } finally { button.disabled = false; }
});

document.getElementById("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showStatus(statusBox, "Signing in…");
  try {
    const result = await accountApi("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    window.uniworkSetSession(result.user);
    await openDashboard(result.user);
    if (safeNextPath) window.location.href = safeNextPath;
  } catch (error) {
    showStatus(statusBox, error.message, "error");
  } finally { button.disabled = false; }
});
document.getElementById("register-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showStatus(statusBox, "Creating your account…");
  try {
    const result = await accountApi("/api/auth/register", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    window.uniworkSetSession(result.user);
    await openDashboard(result.user);
  } catch (error) {
    showStatus(statusBox, error.message, "error");
  } finally { button.disabled = false; }
});
document.getElementById("logout-button").addEventListener("click", async () => {
  try { await accountApi("/api/auth/logout", { method: "POST", body: "{}" }); }
  finally { window.uniworkSetSession(null); window.location.reload(); }
});
document.getElementById("job-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  button.disabled = true;
  try {
    await accountApi("/api/employer/jobs", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    showStatus(dashboardStatus, "Listing sent to the owner for review.", "success");
    await loadEmployerData();
  } catch (error) { showStatus(dashboardStatus, error.message, "error"); }
  finally { button.disabled = false; }
});
document.getElementById("site-content-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const { content } = await accountApi("/api/admin/content", { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    window.dispatchEvent(new CustomEvent("uniwork:content", { detail: content }));
    showStatus(dashboardStatus, "Homepage text saved for every visitor.", "success");
  } catch (error) { showStatus(dashboardStatus, error.message, "error"); }
  finally { button.disabled = false; }
});
document.getElementById("employer-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-delete-job]");
  if (!button) return;
  try { await accountApi(`/api/employer/jobs/${button.dataset.deleteJob}`, { method: "DELETE" }); await loadEmployerData(); }
  catch (error) { showStatus(dashboardStatus, error.message, "error"); }
});
document.getElementById("received-application-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-update-application]");
  if (!button) return;
  try {
    await accountApi(`/api/employer/applications/${button.dataset.updateApplication}`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) });
    showStatus(dashboardStatus, `Application marked ${button.dataset.status}.`, "success");
    await loadEmployerData();
  } catch (error) { showStatus(dashboardStatus, error.message, "error"); }
});
document.getElementById("moderation-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-set-job]");
  if (!button) return;
  try {
    await accountApi(`/api/admin/jobs/${button.dataset.setJob}/status`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) });
    showStatus(dashboardStatus, `Listing ${button.dataset.status}.`, "success");
    await loadAdminData();
  } catch (error) { showStatus(dashboardStatus, error.message, "error"); }
});
