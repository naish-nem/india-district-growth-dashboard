import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { topology } from "topojson-server";

const root = path.resolve("..");
const sourceDir = path.join(root, "sources/repos/India-Built-and-Lit/docs/data");
const outDir = path.resolve("public/data");

const stateNames = {
  "1": "Jammu & Kashmir",
  "2": "Himachal Pradesh",
  "3": "Punjab",
  "4": "Chandigarh",
  "5": "Uttarakhand",
  "6": "Haryana",
  "7": "NCT of Delhi",
  "8": "Rajasthan",
  "9": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman & Diu",
  "26": "Dadra & Nagar Haveli",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (2011)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands"
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function toNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function normalizeId(value) {
  const next = Number(value);
  return Number.isFinite(next) ? String(next) : String(value);
}

function cagr(start, end, years) {
  if (!start || !end || start <= 0 || end <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

function pct(start, end) {
  if (!start || start <= 0 || end == null) return null;
  return end / start - 1;
}

function percentile(values, value) {
  const clean = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!Number.isFinite(value) || clean.length < 2) return null;
  let below = 0;
  for (const item of clean) {
    if (item < value) below += 1;
  }
  return below / (clean.length - 1);
}

function annualStats(monthlyRows) {
  const annual = new Map();
  const quarter = new Map();

  for (const row of monthlyRows) {
    const id = normalizeId(row.pc11_d_id);
    const year = Number(row.year);
    const month = Number(row.month);
    const sum = toNumber(row.sum_radiance);
    const mean = toNumber(row.mean_radiance);
    const pixels = toNumber(row.n_pixels);
    if (!id || !year || sum == null) continue;

    const key = `${id}|${year}`;
    const item = annual.get(key) ?? {
      sumRadiance: 0,
      meanRadianceAcc: 0,
      meanMonths: 0,
      nPixels: 0,
    };
    item.sumRadiance += sum;
    if (mean != null) {
      item.meanRadianceAcc += mean;
      item.meanMonths += 1;
    }
    item.nPixels = Math.max(item.nPixels, pixels ?? 0);
    annual.set(key, item);

    if ([4, 5, 6].includes(month)) {
      const qKey = `${id}|q2_${year}`;
      quarter.set(qKey, (quarter.get(qKey) ?? 0) + sum);
    }
  }

  const byDistrict = new Map();
  for (const [key, item] of annual.entries()) {
    const [id, year] = key.split("|");
    const district = byDistrict.get(id) ?? { annual: {} };
    district.annual[year] = {
      sumRadiance: item.sumRadiance,
      meanRadiance: item.meanMonths ? item.meanRadianceAcc / item.meanMonths : null,
      nPixels: item.nPixels,
      density: item.nPixels ? item.sumRadiance / item.nPixels : null,
    };
    byDistrict.set(id, district);
  }

  return { byDistrict, quarter };
}

function buildingStats(rows) {
  const byDistrict = new Map();
  for (const row of rows) {
    const id = normalizeId(row.pc11_d_id);
    const year = row.year;
    const district = byDistrict.get(id) ?? { annual: {} };
    district.annual[year] = {
      footprintM2: toNumber(row.footprint_m2),
      volumeM3: toNumber(row.volume_m3),
      meanHeightM: toNumber(row.mean_height_m),
    };
    byDistrict.set(id, district);
  }
  return byDistrict;
}

function roundNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const [geoText, ntlText, bvText] = await Promise.all([
    readFile(path.join(sourceDir, "districts_simplified.geojson"), "utf8"),
    readFile(path.join(sourceDir, "viirs_monthly.csv"), "utf8"),
    readFile(path.join(sourceDir, "bv_annual.csv"), "utf8"),
  ]);

  const geo = JSON.parse(geoText);
  geo.features = geo.features
    .filter((feature) => normalizeId(feature.properties.pc11_d_id) !== "0")
    .map((feature) => ({
      ...feature,
      properties: {
        id: normalizeId(feature.properties.pc11_d_id),
        stateId: normalizeId(feature.properties.pc11_s_id),
      },
    }));

  const monthlyRows = parseCsv(ntlText);
  const buildingRows = parseCsv(bvText);
  const ntl = annualStats(monthlyRows);
  const buildings = buildingStats(buildingRows);

  const nameLookup = new Map();
  for (const row of monthlyRows) {
    if (row.pc11_d_id && row.d_name && row.d_name !== "missing") {
      nameLookup.set(normalizeId(row.pc11_d_id), row.d_name);
    }
  }
  for (const row of buildingRows) {
    if (row.pc11_d_id && row.d_name) nameLookup.set(normalizeId(row.pc11_d_id), row.d_name);
  }

  const ids = geo.features.map((feature) => feature.properties.id);
  const records = ids.map((id) => {
    const feature = geo.features.find((item) => item.properties.id === id);
    const stateId = feature.properties.stateId;
    const ntlAnnual = ntl.byDistrict.get(id)?.annual ?? {};
    const builtAnnual = buildings.get(id)?.annual ?? {};
    const annual = {};

    for (const year of Array.from({ length: 12 }, (_, index) => String(2014 + index))) {
      annual[year] = {
        ntlSum: roundNumber(ntlAnnual[year]?.sumRadiance),
        ntlDensity: roundNumber(ntlAnnual[year]?.density),
        nPixels: roundNumber(ntlAnnual[year]?.nPixels),
        footprintM2: roundNumber(builtAnnual[year]?.footprintM2),
        volumeM3: roundNumber(builtAnnual[year]?.volumeM3),
        meanHeightM: roundNumber(builtAnnual[year]?.meanHeightM),
      };
    }

    const ntlLong = cagr(annual["2014"]?.ntlSum, annual["2025"]?.ntlSum, 11);
    const ntlRecent = cagr(annual["2019"]?.ntlSum, annual["2025"]?.ntlSum, 6);
    const ntlAcceleration = ntlRecent != null && ntlLong != null ? ntlRecent - ntlLong : null;
    const ntlGain = annual["2025"]?.ntlSum != null && annual["2019"]?.ntlSum != null
      ? annual["2025"].ntlSum - annual["2019"].ntlSum
      : null;
    const footprintGrowth = cagr(annual["2016"]?.footprintM2, annual["2023"]?.footprintM2, 7);
    const volumeGrowth = cagr(annual["2016"]?.volumeM3, annual["2023"]?.volumeM3, 7);
    const covidShock = pct(ntl.quarter.get(`${id}|q2_2019`), ntl.quarter.get(`${id}|q2_2020`));
    const covidRecovery = pct(ntl.quarter.get(`${id}|q2_2020`), ntl.quarter.get(`${id}|q2_2021`));

    return {
      id,
      name: nameLookup.get(id) ?? `District ${id}`,
      stateId,
      state: stateNames[stateId] ?? `State ${stateId}`,
      annual,
      metrics: {
        ntlLong: roundNumber(ntlLong),
        ntlRecent: roundNumber(ntlRecent),
        ntlAcceleration: roundNumber(ntlAcceleration),
        ntlGain: roundNumber(ntlGain),
        footprintGrowth: roundNumber(footprintGrowth),
        volumeGrowth: roundNumber(volumeGrowth),
        covidShock: roundNumber(covidShock),
        covidRecovery: roundNumber(covidRecovery),
      },
    };
  });

  const percentileKeys = [
    "ntlLong",
    "ntlRecent",
    "ntlAcceleration",
    "ntlGain",
    "footprintGrowth",
    "volumeGrowth",
  ];

  for (const key of percentileKeys) {
    const values = records.map((record) => record.metrics[key]);
    for (const record of records) {
      record.metrics[`${key}Pct`] = roundNumber(percentile(values, record.metrics[key]));
    }
  }

  for (const record of records) {
    const parts = [
      ["ntlRecentPct", 0.34],
      ["ntlLongPct", 0.16],
      ["ntlGainPct", 0.18],
      ["footprintGrowthPct", 0.2],
      ["ntlAccelerationPct", 0.12],
    ];
    let score = 0;
    let weight = 0;
    for (const [key, partWeight] of parts) {
      const value = record.metrics[key];
      if (value != null) {
        score += value * partWeight;
        weight += partWeight;
      }
    }
    record.metrics.agglomerationSpeed = roundNumber(weight ? score / weight : null);
  }

  const topo = topology({ districts: geo });
  await writeFile(path.join(outDir, "india-districts.topo.json"), JSON.stringify(topo));
  await writeFile(path.join(outDir, "district-metrics.json"), JSON.stringify({
    years: Array.from({ length: 12 }, (_, index) => String(2014 + index)),
    stateNames,
    records,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
