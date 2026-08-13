const STORAGE_KEY = "ridee.tripLogs.v2";
const ACTIVE_KEY = "ridee.activeTrip.v2";

const SCORE = {
  movingMinKmh: 3,
  targetMinKmh: 25,
  targetMaxKmh: 35,
  speedMax: 40,
  accelMax: 35,
  decelMax: 25,
  caution: 2.0,
  hard: 2.5,
  severe: 3.0,
  minEventSec: 1.5,
  minMovingSamples: 4,
  minNormalizingDistanceKm: 0.2,
};

const screens = Array.from(document.querySelectorAll(".screen"));
const tabs = Array.from(document.querySelectorAll(".tabs button"));
const tabsWrap = document.querySelector(".tabs");
const phone = document.querySelector(".phone");
const backStack = [];
const topLevelScreens = ["main", "history", "rewards", "settings"];
let swipeStart = null;
let screenTransitioning = false;

const state = {
  activeTrip: readJson(ACTIVE_KEY, null),
  trips: readJson(STORAGE_KEY, []),
  locationWatchId: null,
  sampleTimer: null,
  lastPosition: null,
  lastMotion: null,
  currentSpeedKmh: 0,
  gpsAccuracy: null,
  liveMap: null,
  routeLine: null,
  locationMarker: null,
};

const ids = [
  "ecoScore", "rideToggle", "duration", "speed",
  "distance", "sampleCount", "gpsAccuracy", "motionStatus", "tripCount", "totalDistance",
  "totalSamples", "historyEmpty", "tripList", "tripTitle", "tripScore", "tripStarted",
  "tripEnded", "tripDuration", "tripDistance", "tripSamples", "sampleBars", "mapPanel",
  "routeCanvas", "locationPulse", "averageSpeed",
  "eventCount", "tripAverageSpeed", "tripAccelScore", "tripDecelScore", "tripEcoScore",
];
const els = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatClock(date = new Date()) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).toUpperCase();
}

function formatElapsed(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getElapsedSec(trip) {
  if (!trip) return 0;
  const end = trip.endedAt ? new Date(trip.endedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(trip.startedAt).getTime()) / 1000));
}

function addEvent(trip, label) {
  if (!trip) return;
  trip.events.unshift({ at: new Date().toISOString(), label });
  trip.events = trip.events.slice(0, 20);
}

function getDistanceKm(from, to) {
  const earthKm = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showScreen(target, push = true) {
  const current = screens.find((screen) => screen.classList.contains("active") && !screen.classList.contains("leaving"));
  const next = screens.find((screen) => screen.dataset.screen === target);
  if (!next || current === next || screenTransitioning) return;
  if (push && current && current.dataset.screen !== target && target !== "welcome") {
    backStack.push(current.dataset.screen);
  }
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.go === target));
  tabsWrap.classList.remove("hidden");
  if (target === "history") renderHistory();

  const currentIndex = topLevelScreens.indexOf(current?.dataset.screen);
  const nextIndex = topLevelScreens.indexOf(target);
  const shouldAnimate = current && currentIndex >= 0 && nextIndex >= 0 &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!shouldAnimate) {
    screens.forEach((screen) => screen.classList.toggle("active", screen === next));
    return;
  }

  screenTransitioning = true;
  const direction = nextIndex > currentIndex ? 1 : -1;
  current.classList.add("leaving");
  next.classList.add("active");
  next.style.zIndex = "3";
  current.style.zIndex = "2";
  const timing = { duration: 300, easing: "cubic-bezier(.22,.75,.25,1)", fill: "both" };
  const outgoing = current.animate([
    { transform: "translateX(0)", opacity: 1 },
    { transform: `translateX(${-direction * 28}%)`, opacity: 0.72 },
  ], timing);
  const incoming = next.animate([
    { transform: `translateX(${direction * 100}%)`, opacity: 1 },
    { transform: "translateX(0)", opacity: 1 },
  ], timing);
  Promise.all([outgoing.finished, incoming.finished]).finally(() => {
    current.classList.remove("active", "leaving");
    current.style.zIndex = "";
    next.style.zIndex = "";
    screenTransitioning = false;
  });
}

function goBack() {
  showScreen(backStack.pop() || "main", false);
}

function smoothSpeedSamples(samples) {
  const valid = samples
    .filter((sample) => Number.isFinite(sample.speedKmh))
    .map((sample) => ({ ...sample, timeMs: new Date(sample.at).getTime() }));

  return valid.map((sample, index) => {
    const windowStart = Math.max(0, index - 2);
    const window = valid.slice(windowStart, index + 1);
    const filteredKmh = window.reduce((sum, item) => sum + item.speedKmh, 0) / window.length;
    const previous = index ? valid[index - 1] : null;
    const dtSec = previous ? Math.max(0.25, (sample.timeMs - previous.timeMs) / 1000) : 0;
    return { ...sample, filteredKmh, dtSec };
  });
}

function classifyEvent(peak) {
  if (peak >= SCORE.severe) return "severe";
  if (peak >= SCORE.hard) return "hard";
  return "caution";
}

function countEvents(points, direction) {
  const counts = { caution: 0, hard: 0, severe: 0, total: 0 };
  let durationSec = 0;
  let peak = 0;

  function closeEvent() {
    if (durationSec >= SCORE.minEventSec) {
      counts[classifyEvent(peak)] += 1;
      counts.total += 1;
    }
    durationSec = 0;
    peak = 0;
  }

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    const accel = ((point.filteredKmh - previous.filteredKmh) / 3.6) / point.dtSec;
    if (!Number.isFinite(accel) || Math.abs(accel) > 8) {
      closeEvent();
      continue;
    }
    const value = direction === "accel" ? accel : -accel;
    if (value >= SCORE.caution) {
      durationSec += point.dtSec;
      peak = Math.max(peak, value);
    } else {
      closeEvent();
    }
  }
  closeEvent();
  return counts;
}

function calculateScore(trip) {
  if (!trip) return null;
  const points = smoothSpeedSamples(trip.samples || []);
  const moving = points.filter((point) => point.filteredKmh >= SCORE.movingMinKmh);
  if (moving.length < SCORE.minMovingSamples) return null;

  const averageMovingSpeedKmh = moving.reduce((sum, point) => sum + point.filteredKmh, 0) / moving.length;
  const speedDeviation = averageMovingSpeedKmh < SCORE.targetMinKmh
    ? SCORE.targetMinKmh - averageMovingSpeedKmh
    : Math.max(0, averageMovingSpeedKmh - SCORE.targetMaxKmh);
  const speedScore = Math.max(0, SCORE.speedMax - speedDeviation * 2.5);
  const accelerationEvents = countEvents(points, "accel");
  const decelerationEvents = countEvents(points, "decel");
  const normalizedDistance = Math.max(trip.distanceKm || 0, SCORE.minNormalizingDistanceKm);
  const per10Km = 10 / normalizedDistance;
  const accelPenalty = (2 * accelerationEvents.caution + 4 * accelerationEvents.hard +
    7 * accelerationEvents.severe) * per10Km;
  const decelPenalty = (1 * decelerationEvents.caution + 3 * decelerationEvents.hard +
    5 * decelerationEvents.severe) * per10Km;
  const accelerationScore = Math.max(0, SCORE.accelMax - accelPenalty);
  const decelerationScore = Math.max(0, SCORE.decelMax - decelPenalty);
  const score = Math.round(speedScore + accelerationScore + decelerationScore);

  return {
    score,
    speedScore: Number(speedScore.toFixed(1)),
    accelerationScore: Number(accelerationScore.toFixed(1)),
    decelerationScore: Number(decelerationScore.toFixed(1)),
    averageMovingSpeedKmh: Number(averageMovingSpeedKmh.toFixed(1)),
    accelerationEvents,
    decelerationEvents,
    targetSpeedKmh: "25-35",
    normalizedPerKm: 10,
    updatedAt: new Date().toISOString(),
  };
}

window.RideEScore = { calculateScore };

function scoreLabel(score) {
  if (score == null) return "Start moving";
  if (score >= 85) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 55) return "Needs care";
  return "Slow down smoothly";
}

async function requestMotionAccess() {
  if (!("DeviceMotionEvent" in window)) {
    els.motionStatus.textContent = "Unavailable";
    return;
  }
  try {
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== "granted") {
        els.motionStatus.textContent = "Denied";
        return;
      }
    }
    window.addEventListener("devicemotion", handleMotion);
    els.motionStatus.textContent = "Active";
  } catch {
    els.motionStatus.textContent = "Denied";
  }
}

function handleMotion(event) {
  const source = event.acceleration || event.accelerationIncludingGravity;
  if (!source) return;
  const x = Number(source.x || 0);
  const y = Number(source.y || 0);
  const z = Number(source.z || 0);
  state.lastMotion = {
    x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), z: Number(z.toFixed(3)),
    magnitude: Number(Math.sqrt(x * x + y * y + z * z).toFixed(3)),
  };
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    els.gpsAccuracy.textContent = "Unavailable";
    addEvent(state.activeTrip, "GPS unavailable");
    return;
  }
  state.locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      if (!state.activeTrip) return;
      const coords = position.coords;
      const point = {
        lat: coords.latitude,
        lng: coords.longitude,
        accuracyM: coords.accuracy ?? null,
        atMs: position.timestamp || Date.now(),
      };
      state.gpsAccuracy = point.accuracyM;
      if (state.lastPosition && point.accuracyM != null && point.accuracyM <= 50) {
        const delta = getDistanceKm(state.lastPosition, point);
        if (delta < 0.25) {
          state.activeTrip.distanceKm += delta;
          if (coords.speed == null) {
            const elapsedHours = Math.max(1, point.atMs - state.lastPosition.atMs) / 3600000;
            state.currentSpeedKmh = Math.min(120, delta / elapsedHours);
          }
        }
      }
      if (coords.speed != null) state.currentSpeedKmh = Math.max(0, coords.speed * 3.6);
      state.lastPosition = point;
      saveActiveTrip();
      renderMain();
    },
    () => {
      els.gpsAccuracy.textContent = "Permission needed";
      addEvent(state.activeTrip, "GPS permission needed");
      saveActiveTrip();
      renderMain();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 8000 }
  );
}

function createTrip() {
  return {
    id: `trip-${Date.now()}`, startedAt: new Date().toISOString(), endedAt: null,
    durationSec: 0, distanceKm: 0, ecoScore: null, scoreBreakdown: null,
    samples: [], events: [],
  };
}

async function startRide() {
  if (state.activeTrip) return;
  state.activeTrip = createTrip();
  state.lastPosition = null;
  state.currentSpeedKmh = 0;
  state.gpsAccuracy = null;
  addEvent(state.activeTrip, "Ride started");
  saveActiveTrip();
  renderMain();
  await requestMotionAccess();
  startLocationWatch();
  state.sampleTimer = window.setInterval(recordSample, 1000);
  recordSample();
}

function recordSample() {
  if (!state.activeTrip) return;
  const sample = {
    at: new Date().toISOString(), speedKmh: Number(state.currentSpeedKmh.toFixed(2)),
    gpsAccuracyM: state.gpsAccuracy == null ? null : Number(state.gpsAccuracy.toFixed(1)),
    position: state.lastPosition, motion: state.lastMotion,
  };
  state.activeTrip.samples.push(sample);
  state.activeTrip.durationSec = getElapsedSec(state.activeTrip);
  state.activeTrip.samples = state.activeTrip.samples.slice(-14400);
  state.activeTrip.scoreBreakdown = calculateScore(state.activeTrip);
  state.activeTrip.ecoScore = state.activeTrip.scoreBreakdown?.score ?? null;
  saveActiveTrip();
  renderMain();
}

function stopRide() {
  if (!state.activeTrip) return;
  if (state.locationWatchId != null && navigator.geolocation) navigator.geolocation.clearWatch(state.locationWatchId);
  window.clearInterval(state.sampleTimer);
  state.activeTrip.endedAt = new Date().toISOString();
  state.activeTrip.durationSec = getElapsedSec(state.activeTrip);
  state.activeTrip.distanceKm = Number(state.activeTrip.distanceKm.toFixed(4));
  state.activeTrip.scoreBreakdown = calculateScore(state.activeTrip);
  state.activeTrip.ecoScore = state.activeTrip.scoreBreakdown?.score ?? null;
  addEvent(state.activeTrip, "Ride ended");
  state.trips.unshift(state.activeTrip);
  state.trips = state.trips.slice(0, 50);
  writeJson(STORAGE_KEY, state.trips);
  localStorage.removeItem(ACTIVE_KEY);
  state.activeTrip = null;
  state.locationWatchId = null;
  state.sampleTimer = null;
  state.lastPosition = null;
  state.currentSpeedKmh = 0;
  state.gpsAccuracy = null;
  renderMain();
  renderHistory();
  showScreen("main", false);
}

function saveActiveTrip() {
  if (state.activeTrip) writeJson(ACTIVE_KEY, state.activeTrip);
}

function drawRoute(trip) {
  const canvas = els.routeCanvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const points = (trip?.samples || []).map((sample) => sample.position)
    .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng)).slice(-400);
  if (points.length < 2) {
    els.locationPulse.style.left = "47%";
    els.locationPulse.style.top = "43%";
    return;
  }
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
  const latSpan = Math.max(maxLat - minLat, 0.00025);
  const lngSpan = Math.max(maxLng - minLng, 0.00025);
  const project = (point) => ({
    x: 25 + ((point.lng - minLng) / lngSpan) * (rect.width - 50),
    y: 20 + (1 - (point.lat - minLat) / latSpan) * (rect.height - 78),
  });
  ctx.beginPath();
  points.forEach((point, index) => {
    const p = project(point);
    if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.strokeStyle = "#1779e8";
  ctx.lineWidth = 4;
  ctx.stroke();
  const last = project(points[points.length - 1]);
  els.locationPulse.style.left = `${last.x}px`;
  els.locationPulse.style.top = `${last.y}px`;
}

function updateLiveMap(trip) {
  if (!window.L || !trip || !els.mapPanel) return false;
  const mapElement = document.querySelector("#liveMap");
  if (!state.liveMap) {
    state.liveMap = L.map(mapElement, { zoomControl: false }).setView([18.7883, 98.9853], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.liveMap);
    L.control.zoom({ position: "topright" }).addTo(state.liveMap);
    state.routeLine = L.polyline([], { color: "#1779e8", weight: 5, opacity: 0.95 }).addTo(state.liveMap);
    const markerIcon = L.divIcon({ className: "live-location-marker", iconSize: [20, 20], iconAnchor: [10, 10] });
    state.locationMarker = L.marker([18.7883, 98.9853], { icon: markerIcon }).addTo(state.liveMap);
    els.mapPanel.classList.add("leaflet-ready");
  }
  const points = (trip.samples || []).map((sample) => sample.position)
    .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (points.length) {
    const route = points.map((point) => [point.lat, point.lng]);
    state.routeLine.setLatLngs(route);
    state.locationMarker.setLatLng(route[route.length - 1]);
    if (route.length === 1) state.liveMap.setView(route[0], 16);
    else state.liveMap.panTo(route[route.length - 1], { animate: true, duration: 0.5 });
  }
  window.setTimeout(() => state.liveMap.invalidateSize(), 0);
  return true;
}

function renderMain() {
  const trip = state.activeTrip;
  const breakdown = trip?.scoreBreakdown || calculateScore(trip);
  const score = breakdown?.score ?? null;
  document.querySelector("#main").classList.toggle("ride-active", Boolean(trip));
  els.ecoScore.textContent = score ?? "--";
  els.mapPanel.classList.toggle("hidden", !trip);
  els.rideToggle.textContent = trip ? "End ride" : "Start ride";
  els.rideToggle.classList.toggle("ending", Boolean(trip));
  els.rideToggle.setAttribute("aria-label", trip ? "End current ride" : "Start ride");
  els.duration.textContent = formatElapsed(getElapsedSec(trip));
  els.speed.innerHTML = `${state.currentSpeedKmh.toFixed(1)} <small>km/h</small>`;
  els.distance.innerHTML = `${(trip?.distanceKm || 0).toFixed(2)} <small>km</small>`;
  els.sampleCount.textContent = trip?.samples.length || 0;
  els.gpsAccuracy.textContent = state.gpsAccuracy == null ? "Waiting" : `${state.gpsAccuracy.toFixed(0)} m`;
  els.motionStatus.textContent = state.lastMotion ? "Active" : els.motionStatus.textContent;
  els.averageSpeed.textContent = breakdown ? `${breakdown.averageMovingSpeedKmh.toFixed(1)} km/h` : "--";
  els.eventCount.textContent = breakdown
    ? `${breakdown.accelerationEvents.total} / ${breakdown.decelerationEvents.total}` : "0 / 0";
  window.requestAnimationFrame(() => {
    if (!updateLiveMap(trip)) drawRoute(trip);
  });
}

function renderHistory() {
  const totalDistance = state.trips.reduce((sum, trip) => sum + (trip.distanceKm || 0), 0);
  const totalSamples = state.trips.reduce((sum, trip) => sum + (trip.samples?.length || 0), 0);
  els.tripCount.textContent = state.trips.length;
  els.totalDistance.textContent = `${totalDistance.toFixed(2)} km`;
  els.totalSamples.textContent = totalSamples;
  els.historyEmpty.hidden = state.trips.length > 0;
  els.tripList.innerHTML = state.trips.map((trip, index) => {
    const started = new Date(trip.startedAt);
    return `<button class="trip-item" data-trip-id="${trip.id}"><span><b>Trip #${state.trips.length - index}</b><small>${started.toLocaleDateString()} ${formatClock(started)}</small></span><span><b>${trip.ecoScore ?? "--"}</b><small>${(trip.distanceKm || 0).toFixed(2)} km</small></span></button>`;
  }).join("");
}

function renderTripDetail(tripId) {
  const trip = state.trips.find((item) => item.id === tripId);
  if (!trip) return;
  const breakdown = trip.scoreBreakdown || calculateScore(trip);
  const started = new Date(trip.startedAt);
  const ended = trip.endedAt ? new Date(trip.endedAt) : null;
  els.tripTitle.textContent = `Trip ${formatClock(started)}`;
  els.tripScore.textContent = breakdown?.score ?? "--";
  els.tripStarted.textContent = started.toLocaleString();
  els.tripEnded.textContent = ended ? ended.toLocaleString() : "Active";
  els.tripDuration.textContent = formatElapsed(trip.durationSec || getElapsedSec(trip));
  els.tripDistance.textContent = `${(trip.distanceKm || 0).toFixed(2)} km`;
  els.tripSamples.textContent = trip.samples?.length || 0;
  els.tripAverageSpeed.textContent = breakdown ? `${breakdown.averageMovingSpeedKmh.toFixed(1)} km/h` : "--";
  els.tripAccelScore.textContent = breakdown ? `${breakdown.accelerationScore.toFixed(1)} / 35` : "--";
  els.tripDecelScore.textContent = breakdown ? `${breakdown.decelerationScore.toFixed(1)} / 25` : "--";
  els.tripEcoScore.textContent = `${breakdown?.score ?? "--"} / 100`;
  const maxSpeed = Math.max(1, ...(trip.samples || []).map((sample) => sample.speedKmh || 0));
  const samples = (trip.samples || []).slice(-36);
  els.sampleBars.innerHTML = samples.length
    ? samples.map((sample) => `<i class="${sample.motion ? "motion" : "gps"}" style="height:${Math.max(8, Math.round(((sample.speedKmh || 0) / maxSpeed) * 72))}px" title="${sample.speedKmh || 0} km/h"></i>`).join("")
    : "<p>No samples available.</p>";
  showScreen("trip");
}

document.addEventListener("click", (event) => {
  const go = event.target.closest("[data-go]");
  if (go) { showScreen(go.dataset.go); return; }
  if (event.target.closest("[data-back]")) { goBack(); return; }
  const tripButton = event.target.closest("[data-trip-id]");
  if (tripButton) renderTripDetail(tripButton.dataset.tripId);
});

document.addEventListener("keydown", (event) => { if (event.key === "Escape") goBack(); });

phone.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1 || event.target.closest("#liveMap")) {
    swipeStart = null;
    return;
  }
  const touch = event.touches[0];
  swipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });

phone.addEventListener("touchmove", (event) => {
  if (!swipeStart || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) event.preventDefault();
}, { passive: false });

phone.addEventListener("touchend", (event) => {
  if (!swipeStart || event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) < 55 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;

  const current = screens.find((screen) => screen.classList.contains("active"))?.dataset.screen;
  const currentIndex = topLevelScreens.indexOf(current);
  if (currentIndex < 0) return;
  const nextIndex = dx < 0 ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= topLevelScreens.length) return;
  backStack.length = 0;
  showScreen(topLevelScreens[nextIndex], false);
});

els.rideToggle.addEventListener("click", () => {
  if (state.activeTrip) stopRide();
  else startRide();
});
window.setInterval(() => { if (state.activeTrip) renderMain(); }, 1000);

if (state.activeTrip) {
  addEvent(state.activeTrip, "Recovered active ride");
  saveActiveTrip();
  requestMotionAccess().then(startLocationWatch);
  state.sampleTimer = window.setInterval(recordSample, 1000);
}
renderMain();
renderHistory();
