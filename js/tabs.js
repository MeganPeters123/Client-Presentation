/* Splits the dashboard into tabs rather than one long scroll.
 *
 * Each card carries data-tab, and app.js keeps showing and hiding cards exactly as before —
 * by setting style.display when it has data for them. This file only adds a second, separate
 * gate on top (the tab-off class), so nothing in the render code needs to know tabs exist.
 *
 * A tab whose cards are all hidden by app.js shows a pointer to the Data tab instead of a
 * blank page, and its button is dimmed, so it is obvious which sections have anything in them.
 */

const TAB_STORAGE_KEY = "aum-dashboard-tab";
const TAB_NAMES = ["overview", "allocation", "holdings", "exposure", "activeshare", "trades", "data"];

let activeTab = null;
// Until someone clicks a tab, a first-time visitor starts on Data and is moved to Overview as
// soon as something loads. Once they have picked a tab, it stays where they put it.
let tabChosenByUser = false;

function tabPanels(name) {
  return Array.from(document.querySelectorAll(`.main [data-tab="${name}"]`));
}

function tabHasContent(name) {
  if (name === "data") return true;
  return tabPanels(name).some(el => el.style.display !== "none");
}

function refreshTabState() {
  document.querySelectorAll("#tabBar .tab").forEach(btn => {
    btn.classList.toggle("is-empty", !tabHasContent(btn.dataset.target));
  });
  const empty = document.getElementById("tabEmpty");
  if (activeTab !== "data" && !tabHasContent(activeTab)) {
    empty.innerHTML = 'Nothing to show here yet. Sign in or upload files on the ' +
      '<a href="#" data-goto="data">Data</a> tab.';
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
  }
}

function showTab(name) {
  if (!TAB_NAMES.includes(name)) name = "overview";
  activeTab = name;
  document.querySelectorAll(".main [data-tab]").forEach(el => {
    el.classList.toggle("tab-off", el.dataset.tab !== name);
  });
  document.querySelectorAll("#tabBar .tab").forEach(btn => {
    const on = btn.dataset.target === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    // on a phone the bar is wider than the screen and scrolls sideways
    if (on) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // the Data tab is the whole page now, so there is nothing to collapse it out of the way of
  if (name === "data") document.getElementById("dataPanel").classList.remove("collapsed");
  refreshTabState();
  // a chart drawn while its tab was hidden measured its box as 0 x 0 and stays that way
  // until told to look again
  if (typeof Chart !== "undefined") Object.values(Chart.instances).forEach(c => c.resize());
}

function pickTab(name) {
  tabChosenByUser = true;
  try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (e) {}
  showTab(name);
  window.scrollTo({ top: 0 });
}

(function initTabs() {
  let saved = null;
  try { saved = localStorage.getItem(TAB_STORAGE_KEY); } catch (e) {}
  if (saved && TAB_NAMES.includes(saved)) tabChosenByUser = true;
  showTab(tabChosenByUser ? saved : "data");

  document.getElementById("tabBar").addEventListener("click", e => {
    const btn = e.target.closest(".tab");
    if (btn) pickTab(btn.dataset.target);
  });
  document.getElementById("tabEmpty").addEventListener("click", e => {
    const link = e.target.closest("[data-goto]");
    if (!link) return;
    e.preventDefault();
    pickTab(link.dataset.goto);
  });

  // app.js shows cards by setting style.display, often after an async load, so watch for it
  const observer = new MutationObserver(() => {
    if (!tabChosenByUser && activeTab === "data" && tabHasContent("overview")) {
      showTab("overview");
      return;
    }
    refreshTabState();
  });
  document.querySelectorAll(".main [data-tab]").forEach(el => {
    observer.observe(el, { attributes: true, attributeFilter: ["style"] });
  });
})();
