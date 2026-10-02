const escapeText = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const jobsGrid = document.getElementById("jobs-grid");
const searchInput = document.getElementById("search-input");
const locationSelect = document.getElementById("location-select");
const jobsStatus = document.getElementById("jobs-status");
const applyDialog = document.getElementById("apply-dialog");
let jobs = [];
let activeFilter = "all";
let pendingJobId = null;

function applyHomeContent(content) {
  if (content.home_title) {
    const words = content.home_title.trim().split(/\s+/);
    const highlight = words.pop() || "";
    document.getElementById("hero-title").innerHTML = `${escapeText(words.join(" "))} <span>${escapeText(highlight)}</span>`;
  }
  if (content.home_description) document.getElementById("hero-description").textContent = content.home_description;
}

async function loadHomeContent() {
  try {
    const { content } = await window.uniworkApi("/api/content");
    applyHomeContent(content);
  } catch { /* Keep the bundled copy when offline. */ }
}

function renderJobs() {
  const query = searchInput.value.trim().toLowerCase();
  const location = locationSelect.value;
  const matches = jobs.filter(job => {
    const searchText = `${job.title} ${job.company} ${job.location} ${job.type} ${job.pay} ${job.description}`.toLowerCase();
    const typeMatches = activeFilter === "all" || job.type === activeFilter || (activeFilter === "Remote" && job.location.toLowerCase() === "remote");
    return typeMatches && (!query || searchText.includes(query)) && (!location || job.location === location);
  });
  jobsGrid.innerHTML = matches.length ? matches.map(job => `<article class="job-card"><div class="job-top"><div class="company-mark" aria-hidden="true">${escapeText(job.company.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join("").toUpperCase())}</div><span class="job-badge">${escapeText(job.type)}</span></div><h3>${escapeText(job.title)}</h3><p class="company-line">${escapeText(job.company)} &nbsp;·&nbsp; ${escapeText(job.location)}</p>${job.description ? `<p class="job-description">${escapeText(job.description)}</p>` : ""}<div class="job-meta"><span><strong>${escapeText(job.pay || job.schedule || "See listing")}</strong></span><span class="sample-label">${job.isSample ? "Sample role" : "Live listing"}</span></div>${job.isSample ? "" : `<button class="button button-small apply-button" type="button" data-apply="${job.id}">Apply <span aria-hidden="true">↗</span></button>`}</article>`).join("") : `<div class="empty-state">No matching opportunities right now. Employers can <a href="/account.html?mode=register">create an account and submit a role for review</a>.</div>`;
}

async function loadJobs() {
  try {
    const result = await window.uniworkApi("/api/jobs");
    jobs = result.jobs;
    jobsStatus.textContent = jobs.some(job => !job.isSample) ? "Approved opportunities, updated from UniWork." : "Sample roles are shown for preview; applications open when an employer listing is approved.";
  } catch (error) {
    jobs = [];
    jobsStatus.textContent = "Could not connect to the job service. Check your connection and refresh.";
  }
  renderJobs();
}

searchInput.addEventListener("input", renderJobs);
locationSelect.addEventListener("change", renderJobs);
document.getElementById("search-form").addEventListener("submit", event => { event.preventDefault(); renderJobs(); });
document.querySelectorAll(".filter-chip").forEach(button => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  document.querySelectorAll(".filter-chip").forEach(chip => chip.classList.toggle("active", chip === button));
  renderJobs();
}));
jobsGrid.addEventListener("click", async event => {
  const button = event.target.closest("[data-apply]");
  if (!button) return;
  const user = await window.uniworkSessionReady;
  if (!user) {
    window.location.href = `/account.html?next=${encodeURIComponent("/#opportunities")}`;
    return;
  }
  if (user.role !== "student") {
    jobsStatus.textContent = "Student accounts apply to opportunities. Switch to a student account to apply.";
    return;
  }
  pendingJobId = button.dataset.apply;
  document.getElementById("apply-job-name").textContent = button.closest(".job-card").querySelector("h3").textContent;
  document.getElementById("application-message").value = "";
  document.getElementById("application-status").textContent = "";
  applyDialog.showModal();
});
document.getElementById("close-apply").addEventListener("click", () => applyDialog.close());
applyDialog.addEventListener("click", event => { if (event.target === applyDialog) applyDialog.close(); });
document.getElementById("application-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await window.uniworkApi(`/api/jobs/${pendingJobId}/apply`, {
      method: "POST",
      body: JSON.stringify({ message: document.getElementById("application-message").value })
    });
    applyDialog.close();
    jobsStatus.textContent = "Application sent. You can track it from your account.";
  } catch (error) {
    document.getElementById("application-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.getElementById("year").textContent = new Date().getFullYear();
loadHomeContent();
loadJobs();
setInterval(loadJobs, 60000);
