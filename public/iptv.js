// Cache DOM elements
const elements = {
  categories: document.getElementById("categories"),
  player: document.getElementById("player"),
  channelName: document.getElementById("channelName"),
  videoPlayer: document.getElementById("videoPlayer"),
  searchInput: document.getElementById("searchinput"),
  epgList: document.getElementById("epgList"),
  toastMessage: document.getElementById("toastMessage"),
  updateMenuItem: document.getElementById("updateMenuItem"),
  piconsCheck: document.getElementById("piconsCheck"),
  liveToast: document.getElementById("liveToast"),
};

// Configuration
const layoutConfig = {
  categoriesClasses: ["col-md-2", "col-md-3", "col-md-4"],
  playerClasses: ["col-md-8", "col-md-7", "col-md-6"],
};

// Initialize bootstrap components (Don't create a bootstrap object to avoid conflict)
const toast = new bootstrap.Toast(elements.liveToast);
const bouquetsModal = new bootstrap.Modal(
  document.getElementById("bouquetsModal"),
  {}
);

// State management
let updateEPGTimeout;

// Initialize application
function initApp() {
  loadClassesFromStorage();
  loadSettingsFromStorage();
  setupEventListeners();
  elements.searchInput.focus();
}

// Setup event listeners
function setupEventListeners() {
  // Prevent dropdown from closing when clicking on no-close items
  document.querySelectorAll(".dropdown-item.no-close").forEach((item) => {
    item.addEventListener("click", (event) => event.stopPropagation());
  });

  // Channel click handler
  document.querySelectorAll(".channel-item").forEach((item) => {
    item.addEventListener("click", () => handleChannelClick(item));
  });
}

// Handle channel click
function handleChannelClick(channelItem) {
  const epgUrl = channelItem.getAttribute("epg-url");
  const channelName = channelItem.getAttribute("channel-name");
  const videoUrl = channelItem.getAttribute("data-url");

  // Clear previous EPG update timeout
  clearTimeout(updateEPGTimeout);

  // Clear EPG list to reset details state when changing channels
  elements.epgList.innerHTML = "";

  // Update channel info
  elements.channelName.textContent = channelName;
  fetchEPGData(epgUrl);

  // Play video
  playVideo(videoUrl);
}

// Play video with HLS
function playVideo(videoUrl) {
  const video = elements.videoPlayer;
  const hls = new Hls();

  hls.loadSource(videoUrl);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
}

// Search channels functionality
function searchChannels(search) {
  const searchTerms = search.toLowerCase().trim().split(/\s+/);
  const showAllCollapses = search.length === 1;

  // Filter channel items
  document.querySelectorAll(".channel-item").forEach((item) => {
    const channelText = item.textContent.toLowerCase().trim();
    const matches = searchTerms.every((term) => channelText.includes(term));
    item.style.display = matches ? "" : "none";
  });

  // Update accordion visibility
  document.querySelectorAll(".accordion-item").forEach((item) => {
    const channelList = item.querySelector(
      ".accordion-collapse .accordion-body .list-group"
    );
    const hasVisibleChannels = Array.from(channelList.children).some(
      (channel) =>
        channel instanceof Element &&
        getComputedStyle(channel).display !== "none"
    );

    item.style.display = hasVisibleChannels ? "" : "none";
  });

  if (showAllCollapses) {
    openAllCollapses();
  }
}

// Input clearing
function clearSearchInput() {
  elements.searchInput.value = "";
  searchChannels("");
  closeAllCollapses();
}

// Collapse management
function openAllCollapses() {
  document.querySelectorAll(".collapse").forEach((collapse) => {
    new bootstrap.Collapse(collapse, { toggle: false }).show();
  });
}

function closeAllCollapses() {
  document.querySelectorAll(".collapse.show").forEach((collapse) => {
    new bootstrap.Collapse(collapse, { toggle: false }).hide();
  });
}

function toggleAllCollapses() {
  document.querySelectorAll(".collapse").forEach((collapse) => {
    const bsCollapse = new bootstrap.Collapse(collapse, { toggle: false });
    collapse.classList.contains("show") ? bsCollapse.hide() : bsCollapse.show();
  });
}

// Picons toggle
function togglePicons() {
  document.querySelectorAll(".picon").forEach((picon) => {
    picon.classList.toggle("d-none");
    picon.classList.toggle("d-block");
  });

  document.querySelectorAll(".channel-item").forEach((channelItem) => {
    channelItem.classList.toggle("py-1");
    channelItem.classList.toggle("py-0");
  });

  const showPicons = elements.piconsCheck.checked ? "1" : "0";
  localStorage.setItem("showPicons", showPicons);
}

// Sidebar layout toggle
function toggleSidebar() {
  if (!elements.categories || !elements.player) return;

  const currentCategoriesClass = elements.categories.classList[0];
  const currentPlayerClass = elements.player.classList[0];

  const currentCategoriesIndex = layoutConfig.categoriesClasses.indexOf(
    currentCategoriesClass
  );
  const currentPlayerIndex =
    layoutConfig.playerClasses.indexOf(currentPlayerClass);

  const nextCategoriesIndex =
    (currentCategoriesIndex + 1) % layoutConfig.categoriesClasses.length;
  const nextPlayerIndex =
    (currentPlayerIndex + 1) % layoutConfig.playerClasses.length;

  elements.categories.classList.replace(
    currentCategoriesClass,
    layoutConfig.categoriesClasses[nextCategoriesIndex]
  );
  elements.player.classList.replace(
    currentPlayerClass,
    layoutConfig.playerClasses[nextPlayerIndex]
  );

  localStorage.setItem(
    "categoriesClass",
    layoutConfig.categoriesClasses[nextCategoriesIndex]
  );
  localStorage.setItem(
    "playerClass",
    layoutConfig.playerClasses[nextPlayerIndex]
  );
}

// Load layout from storage
function loadClassesFromStorage() {
  const savedCategoriesClass = localStorage.getItem("categoriesClass");
  const savedPlayerClass = localStorage.getItem("playerClass");

  // Disable transitions temporarily
  elements.categories.style.transition = "none";
  elements.player.style.transition = "none";

  if (savedPlayerClass && savedCategoriesClass) {
    elements.categories.classList.replace("col-md-3", savedCategoriesClass);
    elements.player.classList.replace("col-md-7", savedPlayerClass);
  }

  // Force reflow to ensure transitions are reset
  // eslint-disable-next-line no-unused-expressions
  elements.categories.offsetWidth;
  // eslint-disable-next-line no-unused-expressions
  elements.player.offsetWidth;

  // Re-enable transitions
  elements.categories.style.transition = "";
  elements.player.style.transition = "";
}

// Load picons settings from storage
function loadSettingsFromStorage() {
  const showPicons = localStorage.getItem("showPicons");
  if (showPicons === "0") {
    togglePicons();
    elements.piconsCheck.checked = false;
  }
}

// Utility functions
function decodeBase64(str) {
  return decodeURIComponent(escape(window.atob(str)));
}

function formatTime(dateTimeString) {
  const date = new Date(dateTimeString);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getMinutesDifference(date1, date2) {
  const differenceMs = Math.abs(new Date(date1) - new Date(date2));
  return Math.floor(differenceMs / (1000 * 60));
}

// EPG handling
function populateEPGList(epgData) {
  // Save the open state of existing details elements
  const openDetails = new Set();
  elements.epgList
    .querySelectorAll("details[open]")
    .forEach((details, index) => {
      openDetails.add(index);
    });

  elements.epgList.innerHTML = "";

  epgData.epg_listings.forEach((program, index) => {
    const listItem = document.createElement("li");
    listItem.classList.add("list-group-item", "w-100");

    let html = `<strong>${formatTime(program.start)} - ${formatTime(
      program.end
    )}</strong><br>`;

    // Add program details
    const decodedTitle = decodeBase64(program.title);
    if (program.description) {
      const decodedDescription = decodeBase64(program.description);
      const openAttribute = openDetails.has(index) ? " open" : "";
      html += `<details class='text-muted'${openAttribute}><summary>${decodedTitle}</summary><p>${decodedDescription}</p></details>`;
    } else {
      html += `<div class='text-muted'>${decodedTitle}</div>`;
    }

    // Add progress bar for current program
    if (index === 0) {
      const programLength = getMinutesDifference(program.end, program.start);
      const programProgress =
        (getMinutesDifference(Date.now(), program.start) * 100) / programLength;

      html += `<div class="progress" role="progressbar" aria-label="Program progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax='${programLength}'>
                  <div class="progress-bar bg-secondary" style="width: ${programProgress}%"></div>
                </div>`;
    }

    listItem.innerHTML = html;
    elements.epgList.appendChild(listItem);
  });
}

function fetchEPGData(epgUrl) {
  console.log("Updating EPG data...");

  // Schedule next update at the start of the next minute
  const now = new Date();
  const delay = (60 - now.getSeconds()) * 1000;

  updateEPGTimeout = setTimeout(() => fetchEPGData(epgUrl), delay);

  fetch(epgUrl)
    .then((response) => response.json())
    .then((data) => populateEPGList(data))
    .catch((error) => console.error("Error loading EPG data:", error));
}

// Update channels manually
function updateChannelsManually() {
  elements.updateMenuItem.classList.add("disabled");

  newToast(`<div class='spinner-border text-muted d-block mb-1' role='status'>
                <span class='visually-hidden'>Loading...</span>
              </div>
              Updating bouquets in the background.
              <br>Page will reload when update is finished.`);

  fetch("/update")
    .then((response) => response.json())
    .then((data) => {
      if (data.success) {
        console.log("Successfully updated database...");
        location.reload();
      } else {
        console.error("Error updating database: ", data.error);
        newToast("Error updating database.");
      }
    })
    .catch((error) => newToast(`Error updating database: ${error}`));
}

// Toast notification
function newToast(message) {
  elements.toastMessage.innerHTML = message;
  toast.show();
}

// Webpage fullscreen mode (like ArtPlayer)
function toggleWebpageFullscreen() {
  document.body.classList.toggle("webpage-fullscreen");
  const isFullscreen = document.body.classList.contains("webpage-fullscreen");
  
  // Update button icon
  const btn = document.getElementById("webpageFullscreenBtn");
  if (btn) {
    const icon = btn.querySelector("i");
    if (icon) {
      icon.className = isFullscreen ? "bi bi-fullscreen-exit" : "bi bi-arrows-fullscreen";
    }
    btn.title = isFullscreen ? "Exit webpage fullscreen" : "Webpage fullscreen";
  }
}

// Exit webpage fullscreen on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("webpage-fullscreen")) {
    toggleWebpageFullscreen();
  }
});

// Initialize application on DOMContentLoaded
window.addEventListener("DOMContentLoaded", initApp);
