// script.js
const map = L.map('map', {
  crs: L.CRS.Simple,
  center: [0, 0],
  zoom: -1,
  zoomSnap: 0.5,
  minZoom: 0,
  maxZoom: 3
});

let bounds = [[0, 0], [1000, 1000]];
let backgroundOverlay;
let markerLayers = {};
let devMode = false;
let timestamp = new Date().getTime();
let currentMap = null;
let mapsData = [];
let allVisible = false;
let isInitializing = false;

const mapButtonsContainer = document.getElementById("map-buttons-container");
const layersContainer = document.getElementById("layers-container");
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function updateURLState() {
  if (isInitializing) return;

  // Marker bitmask: we only care about markers on the current floor
  const mapIdx = mapsData.indexOf(currentMap);
  const floorIdx = currentMap ? currentMap.floors.findIndex(f => f.name === document.querySelector("#layers-container .active")?.textContent) : 0;

  let combined = BigInt(mapIdx & 0x1F);
  combined |= (BigInt(floorIdx & 0x1F) << 5n);

  // Use a stable sort to ensure bitmask is consistent regardless of DOM order
  const buttons = Array.from(document.querySelectorAll('.marker-toggle'));
  if (buttons.length === 0) return; // Don't update state if UI is not ready

  buttons.sort((a, b) => a.dataset.markerName.localeCompare(b.dataset.markerName));

  let markerBitmask = 0n;
  const allMarkers = buttons.length;
  let visibleCount = 0;
  buttons.forEach((btn, idx) => {
    if (btn.dataset.visible === "true") {
      markerBitmask |= (1n << BigInt(idx));
      visibleCount++;
    }
  });

  combined |= (BigInt(markerBitmask) << 10n);

  if (allMarkers > 0) {
    if (visibleCount === allMarkers) {
      combined |= (1n << 120n); // Global Override
      combined |= (1n << 121n); // All Visible
    } else if (visibleCount === 0) {
      combined |= (1n << 120n); // Global Override
      // Bit 121 is 0 (All Hidden)
    }
  }

  let base32State = "";
  let temp = combined;
  if (temp === 0n) base32State = BASE32_ALPHABET[0];
  while (temp > 0n) {
    base32State = BASE32_ALPHABET[Number(temp & 31n)] + base32State;
    temp >>= 5n;
  }

  // Ensure leading zeros are preserved if we want fixed length or just handle as is
  // The current decoding logic reconstructs it correctly from the end.

  const url = new URL(window.location);
  const oldS = url.searchParams.get('s');
  if (oldS === base32State) return;

  url.searchParams.set('s', base32State);
  window.history.replaceState({}, '', url);
}

function decodeURLState() {
  const urlParams = new URLSearchParams(window.location.search);
  const s = urlParams.get('s');
  if (!s) return null;

  let combined = 0n;
  for (let i = 0; i < s.length; i++) {
    const val = BigInt(BASE32_ALPHABET.indexOf(s[i].toUpperCase()));
    combined = (combined << 5n) | val;
  }

  const mapIdx = Number(combined & 31n);
  const floorIdx = Number((combined >> 5n) & 31n);
  const markerBitmask = (combined >> 10n) & ((1n << 110n) - 1n); // Support more markers
  const globalOverride = (combined >> 120n) & 1n;
  const globalVisible = (combined >> 121n) & 1n;

  return { mapIdx, floorIdx, markerBitmask, globalOverride, globalVisible };
}

async function init() {
  try {
    isInitializing = true;
    const response = await fetch("maps/manifest.json");
    if (!response.ok) throw new Error(`Failed to fetch manifest: ${response.statusText}`);
    
    const data = await response.json();
    mapsData = data.maps;
    
    const urlState = decodeURLState();
    if (urlState && mapsData[urlState.mapIdx]) {
      currentMap = mapsData[urlState.mapIdx];
    } else {
      currentMap = mapsData[1];
    }

    await loadMapButtons();
    isInitializing = false;
    updateURLState();
  } catch (error) {
    console.error("Initialization error:", error);
    isInitializing = false;
  }
}

async function loadMapButtons() {
  mapButtonsContainer.innerHTML = ""; // Clear existing
  mapsData.forEach((mapData, i) => {
    const button = document.createElement("button");
    button.className = "layer-button"; 
    button.textContent = mapData.name;

    if (currentMap === mapData) button.classList.add("active");
    button.addEventListener("click", async () => {
      if (currentMap === mapData) return;
      document.querySelectorAll("#map-buttons-container .layer-button").forEach(b => b.classList.remove("active"));
      button.classList.add("active");
      currentMap = mapData;
      await loadFloorButtons();
      updateURLState();
    });
    if (i === 4){
	button.disabled = true;
        button.classList.add("disabledButton");
	} 
    mapButtonsContainer.appendChild(button);
  });
  await loadFloorButtons();
}

async function loadFloorButtons() {
  const urlState = decodeURLState();
  layersContainer.innerHTML = "";
  currentMap.floors.forEach((floor, i) => {
    const button = document.createElement("button");
    button.className = "layer-button";
    button.textContent = floor.name;
    
    let isActive = i === 0;
    if (urlState && urlState.mapIdx === mapsData.indexOf(currentMap) && urlState.floorIdx === i) {
      isActive = true;
    }
    
    if (isActive) {
       // Clear other actives if we are setting this one from URL
       document.querySelectorAll("#layers-container .layer-button").forEach(b => b.classList.remove("active"));
       button.classList.add("active");
    }

    button.addEventListener("click", async () => {
      if (button.classList.contains("active")) return;
      document.querySelectorAll("#layers-container .layer-button").forEach(b => b.classList.remove("active"));
      button.classList.add("active");
      await loadFloor(floor.name);
      updateURLState();
    });
    layersContainer.appendChild(button);
  });
  
  const activeFloorButton = layersContainer.querySelector(".layer-button.active");
  await loadFloor(activeFloorButton ? activeFloorButton.textContent : currentMap.floors[0].name);
  map.fitBounds(bounds); 
}

async function loadFloor(floorName) {
  // Clear old markers & categories
  for (let key in markerLayers) markerLayers[key].forEach(m => map.removeLayer(m));
  markerLayers = {};
  document.getElementById("categories-container").innerHTML = "";

  const imagePath = `maps/${currentMap.name}/floors/${floorName}.png`;
  const dataPath = `maps/${currentMap.name}/floors/${floorName}.json?v=${timestamp}`;

  if (backgroundOverlay) map.removeLayer(backgroundOverlay);
  backgroundOverlay = L.imageOverlay(imagePath, bounds).addTo(map);

  try {
    const response = await fetch(dataPath);
    if (!response.ok) throw new Error(`Failed to load floor JSON: ${response.statusText}`);
    const data = await response.json();
    loadMarkers(data);
  } catch (err) {
    console.error("Failed to load floor data:", err);
  }
}

function loadMarkers(data) {	
  const urlState = decodeURLState();
  const categoriesContainer = document.getElementById('categories-container');
  
  // Sort markers by name to ensure consistent bitmask decoding
  const sortedMarkers = [...data.markers].sort((a, b) => a.name.localeCompare(b.name));

  data.markers.forEach((markerData) => {
    let categorySection = document.getElementById(markerData.category);
    if (!categorySection) {
      categorySection = document.createElement('div');
      categorySection.id = markerData.category;
      categorySection.classList.add('category-section');

      const categoryTitle = document.createElement('h4');
      categoryTitle.textContent = markerData.category;
      categorySection.appendChild(categoryTitle);

      const buttonsContainer = document.createElement('div');
      buttonsContainer.classList.add('marker-buttons');
      categorySection.appendChild(buttonsContainer);

      categoriesContainer.appendChild(categorySection);
    }

    const buttonsContainer = categorySection.querySelector('.marker-buttons');
    const iconUrl = markerData.url ? `maps/${markerData.url}` : `maps/Icons/default.png`;

    const button = document.createElement('button');
    button.className = "marker-toggle";
    button.dataset.markerName = markerData.name;
    
    // Determine initial visibility
    let isVisible = true;
    if (urlState) {
      if (urlState.globalOverride === 1n) {
        isVisible = urlState.globalVisible === 1n;
      } else {
        const markerIdxInSorted = sortedMarkers.indexOf(markerData);
        isVisible = (urlState.markerBitmask & (1n << BigInt(markerIdxInSorted))) !== 0n;
      }
    }
    
    button.dataset.visible = isVisible ? "true" : "false";
    if (!isVisible) button.classList.add("disabled");
    
    button.innerHTML = `<img src="${iconUrl}" alt="${markerData.name} icon" class="marker-icon" /><span style="text-align: left;">${markerData.name}</span>`;

    button.addEventListener('click', () => {
      const currentVisible = button.dataset.visible === "true";
      button.dataset.visible = currentVisible ? "false" : "true";
      button.classList.toggle("disabled", currentVisible);
      toggleMarkers(markerData.name, !currentVisible);
      updateURLState();
      checkVisible();
    });

    buttonsContainer.appendChild(button);

    markerData.points.forEach(point => addMarker(markerData, point));
    
    // Apply visibility to markers immediately if hidden
    if (!isVisible) {
      toggleMarkers(markerData.name, false);
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  const markerParam = urlParams.get('marker');
  if (markerParam) {
    filterMarkersByName(markerParam);
  }

  checkVisibleUI();	
  checkVisible();  
}

function checkVisibleUI() {
  const searchVal = document.getElementById('search-bar').value;
  if (searchVal.length > 0) {
    checkSearch(searchVal);
  }
}

function addMarker(markerData, point) {
  const description = point.desc || markerData.desc;
  const iconUrl = markerData.url ? `maps/${markerData.url}` : `maps/Icons/default.png`;

  const markerIcon = L.icon({
    iconUrl: iconUrl,
    iconSize: [26, 26],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });

  const marker = L.marker([point.y, point.x], {
    icon: markerIcon
  }).addTo(map);

  const popupContent = `
    <div class="custom-popup">
      <h3 style='text-align:center;'>${markerData.name}</h3>
      <p style='text-align:center;'>${description}</p>
      ${point.image ? `<img src="maps/${currentMap.name}/${point.image}" alt="${markerData.name} image" class="popup-image" />` : ''}
    </div>
  `;

  marker.bindPopup(popupContent);
  marker.on('click', function() {
    this.openPopup();
  });

  if (!markerLayers[markerData.name]) {
    markerLayers[markerData.name] = [];
  }
  markerLayers[markerData.name].push(marker);
}

function toggleMarkers(name, isVisible) {
  const markers = markerLayers[name];
  if (markers) {
    markers.forEach(marker => {
      isVisible ? marker.addTo(map) : map.removeLayer(marker);
    });
  }
}

function filterMarkersByName(targetName) {
  for (const markerName in markerLayers) {
    const isMatch = markerName.toLowerCase() === targetName.toLowerCase();
    toggleMarkers(markerName, isMatch);

    const button = document.querySelector(`.marker-toggle[data-marker-name="${markerName}"]`);
    if (button) {
      button.dataset.visible = isMatch ? "true" : "false";
      button.classList.toggle("disabled", !isMatch);
    }
  }
}

document.getElementById("mobile-mode-toggle").addEventListener("click", function() {
  document.getElementById('show-menu').style.display = 'block';
  this.parentNode.style.display = 'none';
  document.getElementById("map").style.width = '100%';
  document.getElementById("map").style.margin = '0';
});

document.getElementById("show-menu").addEventListener("click", function() {
  this.style.display = 'none';
  document.getElementById('mobile-mode-toggle').parentNode.style.display = 'block';
});

function checkSearch(value) {
  const searchText = value.toLowerCase();
  const buttons = document.querySelectorAll('.marker-toggle');
  const categoriesList = [];
  const categoriesFound = [];

  buttons.forEach(button => {
    const categorySection = button.closest('.category-section');
    categorySection.style.display = 'block';
    const markerName = button.dataset.markerName.toLowerCase();
    const categoryName = categorySection.id.toLowerCase(); 
    const categoryId = categorySection.id;
    
    if (!categoriesList.includes(categoryId)) {
      categoriesList.push(categoryId);
    }
    if (markerName.includes(searchText) || categoryName.includes(searchText)) {
      categoriesFound.push(categoryId);
      button.style.display = 'flex';
      button.style.height = 'auto';
    } else {
      button.style.display = 'none';
      button.style.height = '0';
    }
  });
  
  categoriesFound.forEach(e => {
    const index = categoriesList.indexOf(e);
    if (index !== -1) {
      categoriesList.splice(index, 1);
    }
  });

  categoriesList.forEach(e => {
    document.getElementById(e).style.display = 'none';
  });
}

document.getElementById('search-bar').addEventListener('input', e => {
  checkSearch(e.target.value);
});

function checkVisible() {
  const toggleAll = document.getElementById('toggle-all');
  if (!toggleAll) return;

  const allMarkers = Array.from(document.querySelectorAll('.marker-toggle'));
  if (allMarkers.length === 0) return;

  const allVisibleStatus = allMarkers.every(b => b.dataset.visible === "true");
  const allHiddenStatus = allMarkers.every(b => b.dataset.visible === "false");

  if (allVisibleStatus) {
    allVisible = true;
    toggleAll.textContent = "Hide Markers";
    toggleAll.classList.remove("all-on");
    toggleAll.classList.add("all-off");
  } else if (allHiddenStatus) {
    allVisible = false;
    toggleAll.textContent = "Show Markers";
    toggleAll.classList.add("all-on");
    toggleAll.classList.remove("all-off");
  } else {
    // Mixed state
    const isSomeVisible = allMarkers.some(b => b.dataset.visible === "true");
    allVisible = isSomeVisible;
    toggleAll.textContent = isSomeVisible ? "Hide Markers" : "Show Markers";
    toggleAll.classList.toggle("all-on", !isSomeVisible);
    toggleAll.classList.toggle("all-off", isSomeVisible);
  }
}

document.getElementById('toggle-all').addEventListener('click', function() {
  const shouldHide = this.textContent.includes("Hide");
  document.querySelectorAll('.marker-toggle').forEach(button => {
    const name = button.dataset.markerName;
    button.dataset.visible = shouldHide ? "false" : "true";
    button.classList.toggle("disabled", shouldHide);
    toggleMarkers(name, !shouldHide);
  });
  updateURLState();
  checkVisible();
});

map.on("click", async event => {
  if (!devMode) return;

  const { lat, lng } = event.latlng;
  const coordinateText = JSON.stringify({ x: lng, y: lat });
  console.log(coordinateText);

  try {
    await navigator.clipboard.writeText(coordinateText);
    console.log("Copied to clipboard:", coordinateText);
  } catch (err) {
    console.error("Failed to copy:", err);
  }
});

init();