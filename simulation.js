const simulationCanvas = document.getElementById("simulationCanvas");
const graphCanvas = document.getElementById("graphCanvas");
const ctx = simulationCanvas.getContext("2d");
const graph = graphCanvas.getContext("2d");

let animation = null;
let currentHour = 0;
let powerData = [];
let simulationRunning = false;
let weatherData = null;
let weatherFetchTimer = null;

let currentLat = 28.6139;
let currentLon = 77.2090;
let currentCityLabel = "New Delhi, India";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const G0 = 1361;
const GSTC = 1000;
const TSTC = 25;
const K = 1.380649e-23;
const Q = 1.602176634e-19;

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function p(id, fallback = 0) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const val = parseFloat(el.value);
  return Number.isFinite(val) ? val : fallback;
}

function updateResolvedLabel() {
  const el = document.getElementById("resolvedLocation");
  if (!el) return;
  const latDir = currentLat >= 0 ? "°N" : "°S";
  const lonDir = currentLon >= 0 ? "°E" : "°W";
  el.textContent =
    currentCityLabel +
    " (" + Math.abs(currentLat).toFixed(2) + latDir +
    ", " + Math.abs(currentLon).toFixed(2) + lonDir + ")";
}

function getParameters() {
  const ratedPower = Math.max(1, p("ratedPower", 400));
  const voc = Math.max(1, p("voc", 49.5));
  const isc = Math.max(0.1, p("isc", 10.5));
  const vmp = clamp(p("vmp", 41.5), 0.5, voc * 0.98);
  const imp = clamp(p("imp", 9.65), 0.05, isc * 0.98);
  const estimatedCells = Math.max(1, Math.round(voc / 0.68));

  return {
    latitude: currentLat,
    longitude: currentLon,
    timezone: weatherData && Number.isFinite(weatherData.utcOffsetHours)
      ? weatherData.utcOffsetHours
      : Math.round(currentLon / 15),
    tilt: clamp(p("tilt", 30), 0, 90),
    azimuth: ((p("azimuth", 180) % 360) + 360) % 360,
    ratedPower,
    voc,
    isc,
    vmp,
    imp,
    cells: estimatedCells,
    ideality: 1.2,
    rs: 0.35,
    rsh: 300,
    iscCoeff: 0.0005,
    vocCoeff: -0.0029,
    noct: 45,
    albedo: 0.20,
    pressure: 1013.25,
    systemLoss: 0.08,
    inverter: clamp(p("inverterEfficiency", 96), 1, 100) / 100
  };
}

function selectedDate() {
  const el = document.getElementById("date");
  if (el && el.value) return el.value;
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function setWeatherStatus(message, isError = false) {
  const el = document.getElementById("weatherStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
}

async function resolveCityCoordinates(query) {
  const clean = (query || "").trim();
  if (!clean) return;

  const coordMatch = clean.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) {
    currentLat = clamp(parseFloat(coordMatch[1]), -90, 90);
    currentLon = clamp(parseFloat(coordMatch[2]), -180, 180);
    currentCityLabel = "Custom Coordinates";
    updateResolvedLabel();
    return;
  }
  try {
    const geoUrl = "https://open-meteo.com" +
      encodeURIComponent(clean) + "&count=1&language=en&format=json";
    const res = await fetch(geoUrl);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error("Geocoding blocked");
    const data = JSON.parse(text);
    if (data.results && data.results.length > 0) {
      const place = data.results[0];
      currentLat = place.latitude;
      currentLon = place.longitude;
      currentCityLabel = place.name + (place.country ? ", " + place.country : "");
      updateResolvedLabel();
      return;
    }
  } catch (e) {
  }

  try {
    const nomUrl = "https://openstreetmap.org" +
      encodeURIComponent(clean) + "&format=json&limit=1";
    const res = await fetch(nomUrl);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      currentLat = parseFloat(data[0].lat);
      currentLon = parseFloat(data[0].lon);
      currentCityLabel = data[0].display_name.split(",").slice(0, 2).join(",");
      updateResolvedLabel();
      return;
    }
  } catch (e2) {
  }

  throw new Error("City '" + clean + "' not found");
}

async function fetchWeatherReport() {
  const cityInput = document.getElementById("cityInput");
  const query = cityInput ? cityInput.value : "New Delhi";
  const dateStr = selectedDate();

  setWeatherStatus("Searching location & fetching weather report...");

  try {
    await resolveCityCoordinates(query);
  } catch (geoErr) {
    setWeatherStatus(geoErr.message + " — keeping " + currentCityLabel + ".", true);
  }

  const lat = currentLat;
  const lon = currentLon;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(dateStr + "T00:00:00");
  const diffDays = Math.floor((today - targetDate) / 86400000);

  const baseUrl = diffDays > 60
    ? "https://open-meteo.com"
    : "https://open-meteo.com";

  const openMeteoUrl = baseUrl +
    "?latitude=" + lat +
    "&longitude=" + lon +
    "&hourly=temperature_2m,shortwave_radiation,direct_normal_irradiance,diffuse_radiation" +
    "&timezone=auto&start_date=" + dateStr +
    "&end_date=" + dateStr;

  try {
    const response = await fetch(openMeteoUrl);
    const text = await response.text();
    if (text.trim().startsWith("<")) {
      throw new Error("Wi-Fi/ISP blocked Open-Meteo");
    }
    const data = JSON.parse(text);

    if (!response.ok || data.error) {
      throw new Error(data.reason || ("HTTP " + response.status));
    }

    if (!data.hourly || !Array.isArray(data.hourly.shortwave_radiation)) {
      throw new Error("Incomplete Open-Meteo data");
    }

    weatherData = {
      date: dateStr,
      timezoneName: data.timezone || "Local",
      utcOffsetHours: (data.utc_offset_seconds || 0) / 3600,
      ghi: data.hourly.shortwave_radiation,
      dni: data.hourly.direct_normal_irradiance,
      dhi: data.hourly.diffuse_radiation,
      temp: data.hourly.temperature_2m
    };

    const maxGhi = Math.max(...weatherData.ghi.map(v => v || 0));
    setWeatherStatus(
      currentCityLabel + " (" + dateStr + ") • Peak GHI: " + maxGhi.toFixed(0) + " W/m²"
    );
  } catch (err) {
    try {
      const wttrUrl = "https://wttr.in" + encodeURIComponent(currentCityLabel) + "?format=j1";
      const wRes = await fetch(wttrUrl);
      const wText = await wRes.text();
      if (wText.trim().startsWith("<")) throw new Error("wttr.in blocked");
      const wData = JSON.parse(wText);
      const hourlyList = wData.weather[0].hourly;

      const ghiArr = [];
      const dniArr = [];
      const dhiArr = [];
      const tempArr = [];

      for (let h = 0; h < 24; h++) {
        const slot = hourlyList[Math.min(Math.floor(h / 3), hourlyList.length - 1)];
        const cloudFraction = clamp((parseFloat(slot.cloudcover) || 0) / 100, 0, 1);
        const s = solarPosition(h);
        const cs = clearSky(s);
        const transmission = 1 - 0.75 * Math.pow(cloudFraction, 3);
        const ghi = cs.ghi * transmission;
        const dni = cs.dni * (1 - cloudFraction);
        const dhi = Math.max(0, ghi - dni * Math.max(0, Math.sin(s.elevation * DEG)));

        ghiArr.push(ghi);
        dniArr.push(dni);
        dhiArr.push(dhi);
        tempArr.push(parseFloat(slot.tempC) || 25);
      }

      weatherData = {
        date: dateStr,
        timezoneName: "wttr.in Live Weather",
        utcOffsetHours: Math.round(lon / 15),
        ghi: ghiArr,
        dni: dniArr,
        dhi: dhiArr,
        temp: tempArr
      };

      const maxGhi = Math.max(...ghiArr);
      setWeatherStatus(
        currentCityLabel + " • Live Weather Loaded (" + dateStr + ") • Peak GHI: " + maxGhi.toFixed(0) + " W/m²"
      );
    } catch (backupErr) {
      weatherData = null;
      setWeatherStatus(
        currentCityLabel + " • Weather API unavailable (" + err.message + ") — Clear-Sky fallback.",
        true
      );
    }
  }

  if (!simulationRunning) {
    if (powerData.length > 1) {
      powerData = powerData.map(item => powerAtHour(item.time));
    }
    updateSimulation();
  }
}

function scheduleWeatherFetch() {
  clearTimeout(weatherFetchTimer);
  weatherFetchTimer = setTimeout(fetchWeatherReport, 500);
}

function interpolateHourly(arr, hour, fallback = 0) {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  const h = clamp(hour, 0, 23.999);
  const i0 = Math.floor(h);
  const i1 = Math.min(arr.length - 1, i0 + 1);
  const frac = h - i0;
  const v0 = Number.isFinite(arr[i0]) ? arr[i0] : fallback;
  const v1 = Number.isFinite(arr[i1]) ? arr[i1] : v0;
  return v0 + (v1 - v0) * frac;
}

function dayOfYear() {
  const d = new Date(selectedDate() + "T12:00:00Z");
  const y = d.getUTCFullYear();
  return Math.floor((d - new Date(y + "-01-01T12:00:00Z")) / 86400000) + 1;
}

function solarPosition(hour) {
  const q = getParameters();
  const n = dayOfYear();
  const lat = q.latitude * DEG;
  const declination = 23.44 * Math.sin((360 * (284 + n) / 365) * DEG);
  const B = (360 * (n - 81) / 364) * DEG;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const standardMeridian = q.timezone * 15;
  const solarTime = hour + (4 * (q.longitude - standardMeridian) + eot) / 60;
  const hourAngle = (solarTime - 12) * 15 * DEG;
  const dec = declination * DEG;
  const sinElevation = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
const elevation = Math.asin(clamp(sinElevation, -1, 1)) * RAD;
const zenith = 90 - elevation;
let azimuth = Math.atan2(
Math.sin(hourAngle),
Math.cos(hourAngle) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)
) * RAD + 180;
azimuth = (azimuth + 360) % 360;
return { zenith, elevation, azimuth };
}
function airMass(z) {
if (z >= 90) return Infinity;
return 1 / (Math.cos(z * DEG) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
}
function clearSky(s) {
if (s.elevation <= 0) return { ghi: 0, dni: 0, dhi: 0 };
const q = getParameters();
const am = airMass(s.zenith);
if (!Number.isFinite(am)) return { ghi: 0, dni: 0, dhi: 0 };
const e0 = G0 * (1 + 0.033 * Math.cos((360 * (dayOfYear() - 3) / 365) * DEG));
const pressureFactor = q.pressure / 1013.25;
const relativeAM = am * pressureFactor;
const tau = 0.18;
const dni = Math.max(0, e0 * Math.exp(-tau * relativeAM));
const beam = dni * Math.sin(s.elevation * DEG);
const dhi = Math.max(0, beam * (0.08 + 0.18 * Math.exp(-s.elevation / 18)));
const ghi = Math.max(0, beam + dhi);
return {
ghi: clamp(ghi, 0, 1300),
dni: clamp(dni, 0, 1300),
dhi: clamp(dhi, 0, 600)
};
}
function weatherConditions(hour, s) {
const ambient = weatherData
? interpolateHourly(weatherData.temp, hour, 25)
: 25;
if (s.elevation <= 0) {
return { ghi: 0, dni: 0, dhi: 0, ambient };
}
if (weatherData) {
const ghi = Math.max(0, interpolateHourly(weatherData.ghi, hour, 0));
const dni = Math.max(0, interpolateHourly(weatherData.dni, hour, 0));
const dhi = Math.max(0, interpolateHourly(weatherData.dhi, hour, 0));
return { ghi, dni, dhi, ambient };
}
const cs = clearSky(s);
return { ghi: cs.ghi, dni: cs.dni, dhi: cs.dhi, ambient };
}
function incidence(z, sa, tilt, pa) {
const c = Math.cos(z * DEG) * Math.cos(tilt * DEG) +
Math.sin(z * DEG) * Math.sin(tilt * DEG) * Math.cos((sa - pa) * DEG);
return Math.acos(clamp(c, -1, 1)) * RAD;
}
function orientation(s) {
const q = getParameters();
if (document.getElementById("tracking").value !== "on" || s.elevation <= 0) {
return { tilt: q.tilt, azimuth: q.azimuth };
}
return { tilt: clamp(s.zenith, 0, 90), azimuth: s.azimuth };
}
function poa(g, s, o) {
if (s.elevation <= 0) return 0;
const a = incidence(s.zenith, s.azimuth, o.tilt, o.azimuth);
const beam = g.dni * Math.max(0, Math.cos(a * DEG));
const diffuse = g.dhi * (1 + Math.cos(o.tilt * DEG)) / 2;
const ground = g.ghi * getParameters().albedo * (1 - Math.cos(o.tilt * DEG)) / 2;
return Math.max(0, beam + diffuse + ground);
}
function opticalFactor(angle) {
const theta = clamp(angle, 0, 89.9) * DEG;
const n1 = 1;
const n2 = 1.526;
const sinT = Math.sin(theta) / n2;
if (sinT >= 1) return 0;
const thetaT = Math.asin(sinT);
const rs = ((n1 * Math.cos(theta) - n2 * Math.cos(thetaT)) / (n1 * Math.cos(theta) + n2 * Math.cos(thetaT))) ** 2;
const rp = ((n1 * Math.cos(thetaT) - n2 * Math.cos(theta)) / (n1 * Math.cos(thetaT) + n2 * Math.cos(theta))) ** 2;
return clamp(1 - (rs + rp) / 2, 0, 1);
}
function moduleTemperature(g, ambient, q) {
return ambient + (q.noct - 20) * g / 800;
}
function thermalVoltage(t, q) {
return q.ideality * q.cells * K * (t + 273.15) / Q;
}
function diodeFromRs(g, t, q, rs, rsh) {
const ge = Math.max(g, 0.001);
const vt = thermalVoltage(t, q);
const isc = Math.max(0, q.isc * (ge / GSTC) * (1 + q.iscCoeff * (t - TSTC)));
const voc = Math.max(0, q.voc + q.vocCoeff * q.voc * (t - TSTC));
const ev = Math.exp(clamp(voc / vt, -100, 700));
const i0 = Math.max(1e-15, (isc - voc / rsh) / Math.max(ev - 1, 1e-15));
const iph = isc + i0 * (Math.exp(clamp(isc * rs / vt, -100, 700)) - 1) + isc * rs / rsh;
return { vt, isc, voc, i0, iph, rs, rsh };
}
function currentAtVoltage(v, d) {
if (d.isc <= 0) return 0;
let i = clamp(d.isc, 0, d.isc * 1.1);
for (let k = 0; k < 50; k++) {
const old = i;
const e = Math.exp(clamp((v + old * d.rs) / d.vt, -100, 700));
const f = d.iph - d.i0 * (e - 1) - (v + old * d.rs) / d.rsh - old;
const df = -d.i0 * e * d.rs / d.vt - d.rs / d.rsh - 1;
if (Math.abs(df) < 1e-12) break;
i = clamp(old - f / df, 0, d.isc * 1.1);
if (Math.abs(i - old) < 1e-8) break;
}
return Math.max(0, i);
}
function derivativeAtVoltage(v, d) {
const i = currentAtVoltage(v, d);
const e = Math.exp(clamp((v + i * d.rs) / d.vt, -100, 700));
const di = -d.i0 * e / d.vt - 1 / d.rsh;
const dv = 1 + d.i0 * e * d.rs / d.vt + d.rs / d.rsh;
return di / dv;
}
function calibrateSTC(q) {
let best = { rs: Math.max(q.rs, 0.001), rsh: Math.max(q.rsh, 1), score: Infinity };
const rsMin = 0.001;
const rsMax = Math.max(2, q.vmp / q.imp * 0.25);
const rshMin = Math.max(10, q.vmp / (q.isc - q.imp + 0.001));
const rshMax = 10000;
for (let pass = 0; pass < 3; pass++) {
const rsA = pass === 0 ? rsMin : Math.max(rsMin, best.rs / 3);
const rsB = pass === 0 ? rsMax : Math.min(rsMax, best.rs * 3);
const rhA = pass === 0 ? rshMin : Math.max(rshMin, best.rsh / 3);
const rhB = pass === 0 ? rshMax : Math.min(rshMax, best.rsh * 3);
for (let ir = 0; ir <= 16; ir++) {
const rs = rsA * Math.pow(rsB / rsA, ir / 16);
for (let ih = 0; ih <= 16; ih++) {
const rsh = rhA * Math.pow(rhB / rhA, ih / 16);
const d = diodeFromRs(GSTC, TSTC, q, rs, rsh);
const i = currentAtVoltage(q.vmp, d);
const slope = derivativeAtVoltage(q.vmp, d);
const powerSlope = q.imp + q.vmp * slope;
const e1 = (i - q.imp) / Math.max(q.imp, 0.1);
const e2 = powerSlope / Math.max(q.imp, 0.1);
const e3 = (currentAtVoltage(0, d) - q.isc) / Math.max(q.isc, 0.1);
const score = e1 * e1 + e2 * e2 + 0.05 * e3 * e3;
if (score < best.score) best = { rs, rsh, score };
}
}
}
return best;
}
let calibrationCache = null;
let calibrationKey = "";
function calibratedParameters(q) {
const key = [q.voc, q.isc, q.vmp, q.imp, q.cells].join("|");
if (key !== calibrationKey) {
calibrationCache = calibrateSTC(q);
calibrationKey = key;
}
return calibrationCache;
}
function diodeModel(g, t, q) {
if (g <= 0) return null;
const c = calibratedParameters(q);
const ge = Math.max(g, 0.001);
const vt = thermalVoltage(t, q);
const isc = Math.max(0, q.isc * (ge / GSTC) * (1 + q.iscCoeff * (t - TSTC)));
const voc = Math.max(0, q.voc + q.vocCoeff * q.voc * (t - TSTC));
const stc = diodeFromRs(GSTC, TSTC, q, c.rs, c.rsh);
const EG_SI = 1.121;
const i0Temp = stc.i0 * Math.pow((t + 273.15) / (TSTC + 273.15), 3) *
Math.exp((Q * EG_SI) / (q.ideality * K) * (1 / (TSTC + 273.15) - 1 / (t + 273.15)));
const i0 = Math.max(1e-15, i0Temp);
const iph = isc + i0 * (Math.exp(clamp(isc * c.rs / vt, -100, 700)) - 1) + isc * c.rs / c.rsh;
return { vt, isc, voc, i0, iph, rs: c.rs, rsh: c.rsh };
}
function mpp(g, t, q) {
if (g <= 0) return { voltage: 0, current: 0, power: 0 };
const d = diodeModel(g, t, q);
let best = { voltage: 0, current: 0, power: 0 };
const steps = 300;
for (let n = 0; n <= steps; n++) {
const v = d.voc * n / steps;
const i = currentAtVoltage(v, d);
const power = v * i;
if (power > best.power) best = { voltage: v, current: i, power };
}
return best;
}
function powerAtHour(hour) {
const q = getParameters();
const s = solarPosition(hour);
const o = orientation(s);
const g = weatherConditions(hour, s);
const angle = s.elevation > 0 ? incidence(s.zenith, s.azimuth, o.tilt, o.azimuth) : 90;
const rawPoa = poa(g, s, o);
const effectivePoa = rawPoa * opticalFactor(angle);
const temp = moduleTemperature(effectivePoa, g.ambient, q);
const point = mpp(effectivePoa, temp, q);
const dc = Math.max(0, Math.min(point.power, q.ratedPower));
const ac = dc * (1 - q.systemLoss) * q.inverter;
return {
time: hour,
elevation: s.elevation,
solarAzimuth: s.azimuth,
zenith: s.zenith,
incidence: angle,
dni: g.dni,
dhi: g.dhi,
ghi: g.ghi,
ambient: g.ambient,
poa: effectivePoa,
temp,
mppVoltage: point.voltage,
mppCurrent: point.current,
dc,
ac,
panelTilt: o.tilt,
panelAzimuth: o.azimuth
};
}
function updateSimulation() {
const r = powerAtHour(currentHour);
const index = powerData.findIndex(x => Math.abs(x.time - currentHour) < 0.0001);
if (index >= 0) powerData[index] = r;
else powerData.push(r);
powerData.sort((a, b) => a.time - b.time);
drawSimulation(r);
drawGraph();
updateResults(r);
updateLog();
}
function startSimulation() {
stopSimulation();
currentHour = 0;
powerData = [];
simulationRunning = true;
updateSimulation();
animation = setInterval(() => {
currentHour += 0.05;
if (currentHour >= 24) {
currentHour = 24;
updateSimulation();
stopSimulation();
} else {
updateSimulation();
}
}, 50);
}
function stopSimulation() {
if (animation) clearInterval(animation);
animation = null;
simulationRunning = false;
}
function resetSimulation() {
stopSimulation();
currentHour = 0;
powerData = [];
updateSimulation();
}
function formatTime(h) {
let hour = Math.floor(h);
let minute = Math.round((h - hour) * 60);
if (minute >= 60) { hour++; minute = 0; }
if (hour >= 24) { hour = 24; minute = 0; }
return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}
function formatLogHour(h) {
const hour24 = Math.round(h);
const h24Str = String(hour24).padStart(2, "0") + ":00";
const period = (hour24 === 12) ? "PM" : (hour24 > 12 && hour24 < 24 ? "PM" : "AM");
const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
return h24Str + " (" + hour12 + " " + period + ")";
}
function dailyEnergy() {
if (powerData.length < 2) return 0;
let e = 0;
for (let i = 1; i < powerData.length; i++) {
e += (powerData[i - 1].ac + powerData[i].ac) / 2 * (powerData[i].time - powerData[i - 1].time);
}
return e / 1000;
}
function updateResults(r) {
const energyKwh = dailyEnergy();
const elapsedHours = powerData.length > 1
? powerData[powerData.length - 1].time - powerData[0].time
: 0;
const avgPower = elapsedHours > 0 ? (energyKwh * 1000) / elapsedHours : r.ac;
document.getElementById("currentTime").textContent = formatTime(r.time);
document.getElementById("currentPower").textContent = r.ac.toFixed(1) + " W";
document.getElementById("maxPower").textContent = Math.max(...powerData.map(x => x.ac), 0).toFixed(1) + " W";
document.getElementById("averagePower").textContent = avgPower.toFixed(1) + " W";
document.getElementById("solarElevation").textContent = r.elevation.toFixed(2) + "°";
document.getElementById("solarAzimuth").textContent = r.solarAzimuth.toFixed(2) + "°";
document.getElementById("incidenceAngle").textContent = r.incidence.toFixed(2) + "°";
document.getElementById("poaIrradiance").textContent = r.poa.toFixed(1) + " W/m²";
document.getElementById("moduleTemperature").textContent = r.temp.toFixed(2) + " °C";
document.getElementById("mppVoltage").textContent = r.mppVoltage.toFixed(2) + " V";
document.getElementById("mppCurrent").textContent = r.mppCurrent.toFixed(2) + " A";
document.getElementById("dcPower").textContent = r.dc.toFixed(1) + " W";
document.getElementById("acPower").textContent = r.ac.toFixed(1) + " W";
document.getElementById("dailyEnergy").textContent = energyKwh.toFixed(3) + " kWh";
}
function updateLog() {
  const body = document.getElementById("logBody");
  body.innerHTML = "";
  const rows = [];

  powerData.forEach(r => {
    const nearestHour = Math.round(r.time);
    if (Math.abs(r.time - nearestHour) < 0.03) {
      if (!rows.some(x => Math.round(x.time) === nearestHour)) {
        rows.push(r);
      }
    }
  });

  rows.forEach(r => {
    const hourStr = String(Math.round(r.time)).padStart(2, "0") + ":00";
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + hourStr + "</td>" +
      "<td>" + r.elevation.toFixed(1) + "</td>" +
      "<td>" + r.solarAzimuth.toFixed(1) + "</td>" +
      "<td>" + r.incidence.toFixed(1) + "</td>" +
      "<td>" + r.dni.toFixed(0) + "</td>" +
      "<td>" + r.dhi.toFixed(0) + "</td>" +
      "<td>" + r.ghi.toFixed(0) + "</td>" +
      "<td>" + r.poa.toFixed(0) + "</td>" +
      "<td>" + r.temp.toFixed(1) + "</td>" +
      "<td>" + r.mppVoltage.toFixed(1) + "</td>" +
      "<td>" + r.mppCurrent.toFixed(2) + "</td>" +
      "<td>" + r.dc.toFixed(1) + "</td>" +
      "<td>" + r.ac.toFixed(1) + "</td>";
    body.appendChild(tr);
  });
}

function drawSimulation(r) {
ctx.clearRect(0, 0, 580, 580);
const sky = ctx.createLinearGradient(0, 0, 0, 580);
sky.addColorStop(0, "#5aa8f5");
sky.addColorStop(1, "#dff5ff");
ctx.fillStyle = sky;
ctx.fillRect(0, 0, 580, 580);
const ground = 450;
ctx.fillStyle = "#689c55";
ctx.fillRect(0, ground, 580, 130);
let sunX = 290;
let sunY = ground + 20;
if (r.elevation > 0) {
const progress = clamp(Math.sin(r.solarAzimuth * DEG) * 0.5 + 0.5, 0, 1);
sunX = 55 + progress * 470;
sunY = ground - clamp(r.elevation / 90, 0, 1) * 320;
const glow = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 60);
glow.addColorStop(0, "rgba(255,230,50,.9)");
glow.addColorStop(1, "rgba(255,230,50,0)");
ctx.fillStyle = glow;
ctx.beginPath();
ctx.arc(sunX, sunY, 60, 0, Math.PI * 2);
ctx.fill();
ctx.fillStyle = "#ffd21f";
ctx.beginPath();
ctx.arc(sunX, sunY, 26, 0, Math.PI * 2);
ctx.fill();
}
const px = 290;
const py = 375;
const w = 190;
const h = 105;
ctx.save();
ctx.translate(px, py);
ctx.rotate(-r.panelTilt * DEG);
ctx.fillStyle = "#182838";
ctx.fillRect(-w / 2 - 7, -h / 2 - 7, w + 14, h + 14);
ctx.fillStyle = "#174f87";
ctx.fillRect(-w / 2, -h / 2, w, h);
ctx.strokeStyle = "rgba(255,255,255,.35)";
ctx.lineWidth = 1;
for (let i = 1; i < 6; i++) {
const x = -w / 2 + i * w / 6;
ctx.beginPath();
ctx.moveTo(x, -h / 2);
ctx.lineTo(x, h / 2);
ctx.stroke();
}
for (let i = 1; i < 4; i++) {
const y = -h / 2 + i * h / 4;
ctx.beginPath();
ctx.moveTo(-w / 2, y);
ctx.lineTo(w / 2, y);
ctx.stroke();
}
ctx.strokeStyle = "#dce6ee";
ctx.lineWidth = 3;
ctx.strokeRect(-w / 2, -h / 2, w, h);
ctx.restore();
ctx.strokeStyle = "#3c3c3c";
ctx.lineWidth = 8;
ctx.beginPath();
ctx.moveTo(px, py + 45);
ctx.lineTo(px, ground);
ctx.stroke();
if (r.elevation > 0) {
ctx.strokeStyle = "rgba(255,225,70,.5)";
ctx.lineWidth = 2;
ctx.setLineDash([8, 8]);
ctx.beginPath();
ctx.moveTo(sunX, sunY);
ctx.lineTo(px, py);
ctx.stroke();
ctx.setLineDash([]);
}
ctx.fillStyle = "#111";
ctx.font = "14px Arial";
ctx.textAlign = "left";
ctx.fillText("City: " + currentCityLabel, 18, 25);
ctx.fillText("Time: " + formatTime(r.time), 18, 47);
ctx.fillText("Ambient Temp: " + r.ambient.toFixed(1) + " °C", 18, 69);
ctx.fillText("Elevation: " + r.elevation.toFixed(2) + "°", 18, 91);
ctx.fillText("POA: " + r.poa.toFixed(1) + " W/m²", 18, 113);
ctx.fillText("AC Power: " + r.ac.toFixed(1) + " W", 18, 135);
ctx.fillText("Tracking: " + (document.getElementById("tracking").value === "on" ? "ON" : "OFF"), 18, 157);
}
function drawGraph() {
graph.clearRect(0, 0, 580, 580);
graph.fillStyle = "#fff";
graph.fillRect(0, 0, 580, 580);
const left = 70;
const right = 550;
const top = 45;
const bottom = 500;
const maxPower = Math.max(...powerData.map(x => x.ac), 100);
const yMax = Math.max(100, Math.ceil(maxPower / 100) * 100);
graph.strokeStyle = "#ddd";
graph.lineWidth = 1;
for (let i = 0; i <= 5; i++) {
const y = bottom - i * (bottom - top) / 5;
graph.beginPath();
graph.moveTo(left, y);
graph.lineTo(right, y);
graph.stroke();
graph.fillStyle = "#222";
graph.font = "12px Arial";
graph.textAlign = "right";
graph.fillText((yMax * i / 5).toFixed(0), left - 8, y + 4);
}
for (let h = 0; h <= 24; h += 2) {
const x = left + h / 24 * (right - left);
graph.beginPath();
graph.moveTo(x, top);
graph.lineTo(x, bottom);
graph.stroke();
graph.fillStyle = "#222";
graph.textAlign = "center";
graph.fillText(String(h).padStart(2, "0"), x, bottom + 20);
}
graph.strokeStyle = "#222";
graph.lineWidth = 2;
graph.beginPath();
graph.moveTo(left, top);
graph.lineTo(left, bottom);
graph.lineTo(right, bottom);
graph.stroke();
graph.fillStyle = "#222";
graph.font = "14px Arial";
graph.textAlign = "center";
graph.fillText("Time (24-hour)", 310, 545);
graph.save();
graph.translate(18, 272);
graph.rotate(-Math.PI / 2);
graph.fillText("AC Power (W)", 0, 0);
graph.restore();
if (!powerData.length) return;
graph.strokeStyle = "#e67e22";
graph.lineWidth = 3;
graph.beginPath();
powerData.forEach((r, i) => {
const x = left + r.time / 24 * (right - left);
const y = bottom - r.ac / yMax * (bottom - top);
if (i === 0) graph.moveTo(x, y);
else graph.lineTo(x, y);
});
graph.stroke();
const x = left + currentHour / 24 * (right - left);
graph.strokeStyle = "#777";
graph.lineWidth = 1;
graph.setLineDash([5, 5]);
graph.beginPath();
graph.moveTo(x, top);
graph.lineTo(x, bottom);
graph.stroke();
graph.setLineDash([]);
}
function showLog() {
const e = document.getElementById("logContainer");
e.style.display = e.style.display === "none" || e.style.display === "" ? "block" : "none";
}
function setDefaultDate() {
const d = new Date();
const y = d.getFullYear();
const m = String(d.getMonth() + 1).padStart(2, "0");
const day = String(d.getDate()).padStart(2, "0");
document.getElementById("date").value = y + "-" + m + "-" + day;
}
function refresh() {
if (!simulationRunning) updateSimulation();
}
document.getElementById("startSimulation").addEventListener("click", startSimulation);
document.getElementById("stopSimulation").addEventListener("click", stopSimulation);
document.getElementById("resetSimulation").addEventListener("click", resetSimulation);
document.getElementById("showLog").addEventListener("click", showLog);
document.getElementById("tracking").addEventListener("change", refresh);
const homeBtn = document.getElementById("homeButton");
if (homeBtn) {
homeBtn.addEventListener("click", () => {
window.location.href = "index.html";
});
}
const cityEl = document.getElementById("cityInput");
if (cityEl) {
cityEl.addEventListener("change", scheduleWeatherFetch);
cityEl.addEventListener("keydown", e => {
if (e.key === "Enter") {
e.preventDefault();
fetchWeatherReport();
}
});
}
const dateEl = document.getElementById("date");
if (dateEl) dateEl.addEventListener("change", scheduleWeatherFetch);
["tilt", "azimuth", "ratedPower", "voc", "isc", "vmp", "imp", "inverterEfficiency"].forEach(id => {
const el = document.getElementById(id);
if (el) el.addEventListener("input", refresh);
});
setDefaultDate();
updateResolvedLabel();
updateSimulation();
fetchWeatherReport();