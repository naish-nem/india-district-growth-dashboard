import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  geoCentroid,
  geoMercator,
  geoPath,
  max,
  min,
  scaleLinear,
  scaleQuantile,
} from "d3";
import { feature } from "topojson-client";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const MAP_WIDTH = 860;
const MAP_HEIGHT = 650;
const BUILT_FORM_YEAR = "2023";
const NTL_YEARS = Array.from({ length: 12 }, (_, index) => String(2014 + index));
const BUILDING_YEARS = Array.from({ length: 8 }, (_, index) => String(2016 + index));
const HIGHLIGHT_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 10, label: "Top 10" },
  { value: 15, label: "Top 15" },
  { value: 25, label: "Top 25" },
];

const PALETTE = {
  red: "#f87171",
  rust: "#fb923c",
  pale: "#1f2937",
  gold: "#fbbf24",
  green: "#34d399",
  teal: "#2dd4bf",
  blue: "#60a5fa",
  missing: "#1c1d24",
  ink: "#f3f4f6",
};

const COLOR_STEPS = [
  PALETTE.red,
  PALETTE.rust,
  PALETTE.pale,
  PALETTE.gold,
  PALETTE.green,
  PALETTE.teal,
  PALETTE.blue,
];

const SEQUENTIAL_STEPS = [
  "#162032",
  "#1d3251",
  "#224a73",
  "#20689a",
  "#148ba6",
  "#0ea5e9",
  "#38bdf8",
];

const METRICS = [
  {
    id: "ntlSum",
    label: "NTL volume",
    unit: "radiance sum",
    description: "Annual sum of monthly VIIRS radiance by district.",
    timed: true,
    mode: "sequential",
    formatter: formatCompact,
  },
  {
    id: "ntlDensity",
    label: "NTL density",
    unit: "radiance/pixel",
    description: "Annual NTL volume divided by district pixel count.",
    timed: true,
    mode: "sequential",
    formatter: formatDecimal,
  },
  {
    id: "footprintM2",
    label: "Building footprint",
    unit: "m^2",
    description: "Annual built footprint from Google Open Buildings.",
    timed: true,
    mode: "sequential",
    formatter: formatCompact,
  },
  {
    id: "volumeM3",
    label: "Building volume",
    unit: "m^3",
    description: "Annual built volume. Treat height-driven changes cautiously.",
    timed: true,
    mode: "sequential",
    formatter: formatCompact,
  },
  {
    id: "ntlRecent",
    label: "NTL growth, 2019-2025",
    unit: "annualized",
    description: "Annualized growth in district NTL volume from 2019 to 2025.",
    timed: false,
    mode: "growth",
    formatter: formatPercent,
  },
  {
    id: "ntlLong",
    label: "NTL growth, 2014-2025",
    unit: "annualized",
    description: "Annualized growth in district NTL volume from 2014 to 2025.",
    timed: false,
    mode: "growth",
    formatter: formatPercent,
  },
  {
    id: "ntlAcceleration",
    label: "NTL acceleration",
    unit: "percentage points",
    description: "Recent NTL growth minus long-run NTL growth.",
    timed: false,
    mode: "acceleration",
    formatter: formatPoints,
  },
  {
    id: "footprintGrowth",
    label: "Footprint growth, 2016-2023",
    unit: "annualized",
    description: "Annualized building footprint growth.",
    timed: false,
    mode: "growth",
    formatter: formatPercent,
  },
  {
    id: "agglomerationSpeed",
    label: "Agglomeration speed",
    unit: "0-100 score",
    description: "Composite percentile score from NTL growth, NTL gain, footprint growth, and acceleration.",
    timed: false,
    mode: "score",
    formatter: formatScore,
  },
  {
    id: "covidShock",
    label: "Shock, Q2 2020",
    unit: "change vs Q2 2019",
    description: "NTL change in Apr-Jun 2020 relative to Apr-Jun 2019.",
    timed: false,
    mode: "shock",
    formatter: formatPercent,
  },
];

const TEMPORAL_YEARS = ["2014", "2016", "2018", "2020", "2023", "2025"];

const LAYERS = [
  {
    id: "buildingVolume",
    label: "Building volume",
    shortLabel: "Volume",
    metricId: "volumeM3",
    years: BUILDING_YEARS,
    description: "Footprint sets the cylinder base; modeled mean height sets the column height. The 3D mass is the visual proxy for building volume.",
    topSummary: "Base = building footprint (m^2); height = mean modeled height (m); cylinder mass represents building volume (m^3).",
    baseLabel: "Footprint area",
    baseUnit: "m^2",
    heightLabel: "Mean modeled height",
    heightUnit: "m",
  },
  {
    id: "buildingFootprint",
    label: "Building footprint",
    shortLabel: "Footprint",
    metricId: "footprintM2",
    years: BUILDING_YEARS,
    description: "Every district uses the same base. Height carries building footprint so base size does not distort the comparison.",
    topSummary: "Base = fixed for every district; height = building footprint (m^2). This layer compares footprint through height only.",
    baseLabel: "Fixed district marker",
    baseUnit: "same radius",
    heightLabel: "Footprint area",
    heightUnit: "m^2",
  },
  {
    id: "ntlVolume",
    label: "Nighttime volume",
    shortLabel: "NTL volume",
    metricId: "ntlSum",
    years: NTL_YEARS,
    description: "District spikes show annual nighttime-light volume.",
    topSummary: "Cone height represents annual NTL volume; base width uses NTL density for spatial emphasis.",
    baseLabel: "NTL density",
    baseUnit: "radiance/pixel",
    heightLabel: "NTL volume",
    heightUnit: "radiance sum",
  },
  {
    id: "ntlDensity",
    label: "NTL density",
    shortLabel: "NTL density",
    metricId: "ntlDensity",
    years: NTL_YEARS,
    description: "District spikes show nighttime-light intensity per lit pixel.",
    topSummary: "Cone height represents NTL density; base width uses NTL volume for spatial emphasis.",
    baseLabel: "NTL volume",
    baseUnit: "radiance sum",
    heightLabel: "NTL density",
    heightUnit: "radiance/pixel",
  },
];

function formatPercent(value) {
  return value == null ? "NA" : `${(value * 100).toFixed(1)}%`;
}

function formatPoints(value) {
  return value == null ? "NA" : `${(value * 100).toFixed(1)} pp`;
}

function formatScore(value) {
  return value == null ? "NA" : Math.round(value * 100).toString();
}

function formatDecimal(value) {
  return value == null ? "NA" : value.toFixed(2);
}

function formatHeight(value) {
  return value == null ? "NA" : `${value.toFixed(2)} m`;
}

function formatCompact(value) {
  if (value == null) return "NA";
  return Intl.NumberFormat("en-IN", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function metricValue(record, metric, year) {
  if (!record) return null;
  if (metric.timed) return record.annual?.[year]?.[metric.id] ?? null;
  return record.metrics?.[metric.id] ?? null;
}

function colorFor(metric, value, values) {
  if (value == null || !Number.isFinite(value)) return PALETTE.missing;

  if (metric.mode === "sequential") {
    const scale = scaleQuantile()
      .domain(values.filter((item) => item != null && Number.isFinite(item)))
      .range(SEQUENTIAL_STEPS);
    return scale(value);
  }

  if (metric.mode === "score") {
    if (value < 0.15) return COLOR_STEPS[0];
    if (value < 0.3) return COLOR_STEPS[1];
    if (value < 0.45) return COLOR_STEPS[2];
    if (value < 0.6) return COLOR_STEPS[3];
    if (value < 0.75) return COLOR_STEPS[4];
    if (value < 0.9) return COLOR_STEPS[5];
    return COLOR_STEPS[6];
  }

  if (metric.mode === "acceleration") {
    if (value < -0.04) return COLOR_STEPS[0];
    if (value < -0.015) return COLOR_STEPS[1];
    if (value < 0.005) return COLOR_STEPS[2];
    if (value < 0.025) return COLOR_STEPS[3];
    if (value < 0.05) return COLOR_STEPS[4];
    if (value < 0.08) return COLOR_STEPS[5];
    return COLOR_STEPS[6];
  }

  if (metric.mode === "shock") {
    if (value < -0.2) return COLOR_STEPS[0];
    if (value < -0.1) return COLOR_STEPS[1];
    if (value < -0.03) return COLOR_STEPS[2];
    if (value < 0.03) return COLOR_STEPS[3];
    if (value < 0.1) return COLOR_STEPS[4];
    if (value < 0.2) return COLOR_STEPS[5];
    return COLOR_STEPS[6];
  }

  if (value < 0) return COLOR_STEPS[0];
  if (value < 0.02) return COLOR_STEPS[1];
  if (value < 0.04) return COLOR_STEPS[2];
  if (value < 0.06) return COLOR_STEPS[3];
  if (value < 0.08) return COLOR_STEPS[4];
  if (value < 0.12) return COLOR_STEPS[5];
  return COLOR_STEPS[6];
}

function legendLabels(metric, values, formatter) {
  if (metric.mode === "sequential") {
    const domain = values.filter((item) => item != null && Number.isFinite(item)).sort((a, b) => a - b);
    if (!domain.length) return [];
    const scale = scaleQuantile().domain(domain).range(SEQUENTIAL_STEPS);
    return scale.quantiles().map((value, index, arr) => {
      const start = index === 0 ? "low" : formatter(arr[index - 1]);
      return `${start} to ${formatter(value)}`;
    }).concat(`> ${formatter(scale.quantiles().at(-1))}`);
  }
  if (metric.mode === "score") return ["0-15", "15-30", "30-45", "45-60", "60-75", "75-90", "90-100"];
  if (metric.mode === "acceleration") return ["< -4 pp", "-4 to -1.5", "-1.5 to 0.5", "0.5 to 2.5", "2.5 to 5", "5 to 8", "> 8 pp"];
  if (metric.mode === "shock") return ["< -20%", "-20 to -10", "-10 to -3", "-3 to 3", "3 to 10", "10 to 20", "> 20%"];
  return ["< 0%", "0-2", "2-4", "4-6", "6-8", "8-12", "> 12%"];
}

function useDashboardData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([
      fetch("/data/india-districts.topo.json").then((response) => response.json()),
      fetch("/data/district-metrics.json").then((response) => response.json()),
    ])
      .then(([topology, metrics]) => {
        if (ignore) return;
        const districts = feature(topology, topology.objects.districts);
        setData({ districts, metrics });
      })
      .catch((nextError) => {
        if (!ignore) setError(nextError);
      });
    return () => {
      ignore = true;
    };
  }, []);

  return { data, error };
}

export default function App() {
  const { data, error } = useDashboardData();
  const didDefaultSelectRef = useRef(false);
  const [layerId, setLayerId] = useState("buildingVolume");
  const [year, setYear] = useState(BUILT_FORM_YEAR);
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [highlightLimit, setHighlightLimit] = useState(0);

  const activeLayer = useMemo(
    () => LAYERS.find((layer) => layer.id === layerId) ?? LAYERS[0],
    [layerId],
  );
  const activeMetric = useMemo(
    () => METRICS.find((metric) => metric.id === activeLayer.metricId) ?? METRICS[0],
    [activeLayer],
  );

  const recordsById = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.metrics.records.map((record) => [record.id, record]));
  }, [data]);

  useEffect(() => {
    if (!didDefaultSelectRef.current && data?.metrics.records.length) {
      didDefaultSelectRef.current = true;
      setSelectedId(data.metrics.records.find((record) => record.name === "Bangalore Rural")?.id ?? data.metrics.records[0].id);
    }
  }, [data]);

  useEffect(() => {
    if (!activeLayer.years.includes(year)) {
      setYear(activeLayer.years.at(-1));
    }
  }, [activeLayer, year]);

  const selected = selectedId ? recordsById.get(selectedId) : null;

  const metricValues = useMemo(() => {
    if (!data) return [];
    return data.metrics.records.map((record) => metricValue(record, activeMetric, year));
  }, [activeMetric, data, year]);

  const rankedRecords = useMemo(() => {
    if (!data) return [];
    return data.metrics.records
      .map((record) => ({ record, value: metricValue(record, activeMetric, year) }))
      .filter((item) => item.value != null && Number.isFinite(item.value))
      .sort((a, b) => b.value - a.value);
  }, [activeMetric, data, year]);

  const highlightedRecords = useMemo(() => (
    highlightLimit > 0 ? rankedRecords.slice(0, highlightLimit).map((item) => item.record) : []
  ), [highlightLimit, rankedRecords]);

  const highlightedIds = useMemo(
    () => new Set(highlightedRecords.map((record) => record.id)),
    [highlightedRecords],
  );

  const handleLayerChange = useCallback((nextLayerId) => {
    const nextLayer = LAYERS.find((layer) => layer.id === nextLayerId);
    if (nextLayer && !nextLayer.years.includes(year)) {
      setYear(nextLayer.years.at(-1));
    }
    setLayerId(nextLayerId);
  }, [year]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setHoveredId(null);
  }, []);

  if (error) {
    return <main className="loading">Data failed to load: {error.message}</main>;
  }

  if (!data) {
    return <main className="loading">Loading district topology and metrics...</main>;
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">District panel atlas</div>
          <h1>India district volume surfaces</h1>
          <p>
            {activeLayer.topSummary}
          </p>
        </div>
        <div className="header-grid">
          <MetricTile value={data.metrics.records.length.toLocaleString("en-IN")} label="districts" />
          <MetricTile value={year} label="active year" />
          <MetricTile value={activeLayer.baseLabel} label="base encodes" detail={activeLayer.baseUnit} />
          <MetricTile value={activeLayer.heightLabel} label="height encodes" detail={activeLayer.heightUnit} />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="control-block">
            <h2>Layer</h2>
            <div className="metric-list">
              {LAYERS.map((layer) => (
                <button
                  className={layer.id === activeLayer.id ? "active" : ""}
                  key={layer.id}
                  type="button"
                  onClick={() => handleLayerChange(layer.id)}
                >
                  <span>{layer.label}</span>
                  <small>{layer.years[0]}-{layer.years.at(-1)}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="control-block">
            <h3>Year</h3>
            <div className="year-readout">{year}</div>
            <div className="year-buttons">
              {NTL_YEARS.map((nextYear) => {
                const isAvailable = activeLayer.years.includes(nextYear);
                return (
                <button
                  className={nextYear === year ? "active" : ""}
                  disabled={!isAvailable}
                  key={nextYear}
                  type="button"
                  onClick={() => setYear(nextYear)}
                >
                  {nextYear}
                </button>
                );
              })}
            </div>
          </div>

          <div className="control-block">
            <h3>Focus</h3>
            <div className="focus-readout">
              {selected ? (
                <>
                  <strong>{selected.name}</strong>
                  <span>{selected.state}</span>
                </>
              ) : (
                <span>No district selected</span>
              )}
            </div>
            <button className="clear-button" type="button" onClick={clearSelection}>
              Clear selection
            </button>
          </div>

          <div className="control-block">
            <h3>Highlight ranked districts</h3>
            <div className="highlight-options" role="group" aria-label="Highlight ranked districts">
              {HIGHLIGHT_OPTIONS.map((option) => (
                <button
                  className={highlightLimit === option.value ? "active" : ""}
                  key={option.value}
                  type="button"
                  onClick={() => setHighlightLimit(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="highlight-summary">
              {highlightLimit > 0
                ? `Labeling the ${highlightedRecords.length} highest ${activeMetric.label.toLowerCase()} districts for ${year}.`
                : "Single district focus only."}
            </p>
          </div>

          <div className="control-note">
            {activeLayer.description} Years only appear when data exists for the active layer.
          </div>
        </aside>

        <section className="map-stage">
          <BuiltFormHeader
            highlightLimit={highlightLimit}
            layer={activeLayer}
            metric={activeMetric}
            year={year}
          />
          <BuiltFormScene
            districts={data.districts}
            highlightedIds={highlightedIds}
            hoveredId={hoveredId}
            layer={activeLayer}
            metric={activeMetric}
            recordsById={recordsById}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            values={metricValues}
            year={year}
          />
        </section>

        <aside className="detail-panel">
          <DistrictDetail layer={activeLayer} metric={activeMetric} record={selected} year={year} />
          <RankingPanel
            formatter={activeMetric.formatter}
            rankedRecords={rankedRecords}
            title="Highest values"
          />
          <RankingPanel
            formatter={activeMetric.formatter}
            rankedRecords={rankedRecords.slice().reverse()}
            title="Lowest values"
          />
        </aside>
      </section>

      <section className="analysis-grid">
        <ScatterPanel
          highlightedIds={highlightedIds}
          hoveredId={hoveredId}
          records={data.metrics.records}
          selectedId={selectedId}
          setHoveredId={setHoveredId}
          setSelectedId={setSelectedId}
        />
        <FootprintVolumePanel
          highlightedIds={highlightedIds}
          hoveredId={hoveredId}
          records={data.metrics.records}
          selectedId={selectedId}
          setHoveredId={setHoveredId}
          setSelectedId={setSelectedId}
        />
        <NtlDensityVolumePanel
          highlightedIds={highlightedIds}
          hoveredId={hoveredId}
          records={data.metrics.records}
          selectedId={selectedId}
          setHoveredId={setHoveredId}
          setSelectedId={setSelectedId}
          year={year}
        />
      </section>

      <section className="method-panel">
        <div>
          <h2>Representation choices</h2>
          <p>
            The 3D layer uses district aggregates, not raw building polygons or pixel-level light rasters.
          </p>
        </div>
        <div className="method-cards">
          <MethodCard title="Linked views" text="Click a point or cylinder to select the same district everywhere." />
          <MethodCard title="Layer years" text="Building layers expose 2016-2023. NTL exposes 2014-2025." />
          <MethodCard title="Caution" text="District columns show aggregate values and should not be read as individual structures." />
        </div>
      </section>
    </main>
  );
}

function MetricTile({ value, label, detail }) {
  return (
    <div className="metric-tile">
      <strong>{value}</strong>
      <span>{label}</span>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function BuiltFormHeader({ highlightLimit, layer, metric, year }) {
  return (
    <div className="map-header">
      <div>
        <h2>{layer.label}</h2>
        <p>
          {year} - {metric.description}
          {highlightLimit > 0 ? ` Top ${highlightLimit} districts are labeled across the map and graphs.` : ""}
        </p>
      </div>
    </div>
  );
}

function MapHeader({ metric, values }) {
  return (
    <div className="map-header">
      <div>
        <h2>{metric.label}</h2>
        <p>{metric.description}</p>
      </div>
      <Legend metric={metric} values={values} />
    </div>
  );
}

function Legend({ metric, values }) {
  const steps = metric.mode === "sequential" ? SEQUENTIAL_STEPS : COLOR_STEPS;
  const labels = legendLabels(metric, values, metric.formatter);
  return (
    <div className="legend">
      {steps.map((color, index) => (
        <div className="legend-row" key={`${color}-${index}`}>
          <span style={{ backgroundColor: color }} />
          <small>{labels[index] ?? ""}</small>
        </div>
      ))}
      <div className="legend-row">
        <span style={{ backgroundColor: PALETTE.missing }} />
        <small>missing</small>
      </div>
    </div>
  );
}

function projectPoint(projection, point) {
  const [x, y] = projection(point);
  return [(x - MAP_WIDTH / 2) * 0.78, (y - MAP_HEIGHT / 2) * 0.78];
}

function collectBoundarySegments(features, projection) {
  const vertices = [];

  const addRing = (ring) => {
    for (let index = 1; index < ring.length; index += 1) {
      const [x1, z1] = projectPoint(projection, ring[index - 1]);
      const [x2, z2] = projectPoint(projection, ring[index]);
      vertices.push(x1, 0.5, z1, x2, 0.5, z2);
    }
  };

  for (const item of features) {
    const { geometry } = item;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      geometry.coordinates.forEach(addRing);
    }
    if (geometry.type === "MultiPolygon") {
      geometry.coordinates.forEach((polygon) => polygon.forEach(addRing));
    }
  }

  return vertices;
}

function layerValues(record, layer, year) {
  const annual = record?.annual?.[year];
  if (!annual) return null;

  if (layer.id === "ntlVolume") {
    const volume = annual.ntlSum;
    const density = annual.ntlDensity;
    if (!Number.isFinite(volume) || volume <= 0) return null;
    return {
      heightValue: volume,
      baseValue: Number.isFinite(density) && density > 0 ? density : volume,
      colorValue: volume,
      primaryValue: volume,
      secondaryValue: density,
      primaryLabel: "ntl volume",
      secondaryLabel: "ntl density",
    };
  }

  if (layer.id === "ntlDensity") {
    const volume = annual.ntlSum;
    const density = annual.ntlDensity;
    if (!Number.isFinite(density) || density <= 0) return null;
    return {
      heightValue: density,
      baseValue: Number.isFinite(volume) && volume > 0 ? volume : density,
      colorValue: density,
      primaryValue: density,
      secondaryValue: volume,
      primaryLabel: "ntl density",
      secondaryLabel: "ntl volume",
    };
  }

  const footprint = annual.footprintM2;
  const volume = annual.volumeM3;
  const meanHeight = annual.meanHeightM;
  if (!Number.isFinite(footprint) || footprint <= 0 || !Number.isFinite(volume) || volume <= 0) return null;

  if (layer.id === "buildingFootprint") {
    return {
      heightValue: footprint,
      baseValue: 1,
      colorValue: footprint,
      primaryValue: footprint,
      secondaryValue: volume,
      primaryLabel: "footprint m2",
      secondaryLabel: "volume m3",
    };
  }

  return {
    heightValue: Number.isFinite(meanHeight) && meanHeight > 0 ? meanHeight : null,
    baseValue: footprint,
    colorValue: volume,
    primaryValue: volume,
    secondaryValue: footprint,
    primaryLabel: "volume m3",
    secondaryLabel: "footprint m2",
  };
}

function createLabelSprite(text, color) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = "600 24px IBM Plex Sans, sans-serif";
  const width = Math.ceil(context.measureText(text).width + 30);
  canvas.width = width;
  canvas.height = 42;
  context.font = "600 24px IBM Plex Sans, sans-serif";
  context.fillStyle = "rgba(7, 8, 12, 0.76)";
  context.strokeStyle = "rgba(255, 255, 255, 0.14)";
  context.lineWidth = 1;
  context.beginPath();
  if (typeof context.roundRect === "function") {
    context.roundRect(0.5, 0.5, width - 1, 41, 8);
  } else {
    context.rect(0.5, 0.5, width - 1, 41);
  }
  context.fill();
  context.stroke();
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, 15, 22);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width * 0.24, 10, 1);
  return sprite;
}

function BuiltFormScene({
  districts,
  highlightedIds,
  hoveredId,
  layer,
  metric,
  recordsById,
  selectedId,
  setSelectedId,
  values,
  year,
}) {
  const mountRef = useRef(null);

  const sceneData = useMemo(() => {
    const projection = geoMercator().fitSize([MAP_WIDTH, MAP_HEIGHT], districts);
    const rows = districts.features
      .map((district) => {
        const record = recordsById.get(district.properties.id);
        const encoded = layerValues(record, layer, year);
        if (!record || !encoded || !Number.isFinite(encoded.heightValue) || encoded.heightValue <= 0) return null;
        const [x, z] = projectPoint(projection, geoCentroid(district));
        return {
          id: record.id,
          name: record.name,
          state: record.state,
          x,
          z,
          ...encoded,
        };
      })
      .filter(Boolean);

    return {
      boundarySegments: collectBoundarySegments(districts.features, projection),
      rows,
    };
  }, [districts, layer, recordsById, year]);

  const focusId = selectedId ?? hoveredId;
  const selectedRow = useMemo(
    () => sceneData.rows.find((row) => row.id === focusId) ?? sceneData.rows[0],
    [focusId, sceneData.rows],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x07080c, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x07080c, 620, 1150);

    const camera = new THREE.OrthographicCamera(-420, 420, 260, -260, 1, 1800);
    camera.position.set(0, 520, 610);
    camera.lookAt(0, 0, 10);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minZoom = 0.7;
    controls.maxZoom = 2.3;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
    controls.target.set(0, 32, 0);

    const ambient = new THREE.AmbientLight(0x6f7f90, 1.7);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffd27a, 2.7);
    keyLight.position.set(-260, 520, 280);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x7dd3fc, 1.4);
    fillLight.position.set(360, 260, -320);
    scene.add(fillLight);

    const boundaryGeometry = new THREE.BufferGeometry();
    boundaryGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(sceneData.boundarySegments, 3),
    );
    const boundaryMaterial = new THREE.LineBasicMaterial({
      color: 0x55708f,
      transparent: true,
      opacity: 0.72,
    });
    const boundaryLines = new THREE.LineSegments(boundaryGeometry, boundaryMaterial);
    scene.add(boundaryLines);

    const baseValues = sceneData.rows.map((row) => row.baseValue);
    const heightValues = sceneData.rows.map((row) => row.heightValue);
    const baseScale = scaleLinear()
      .domain([Math.sqrt(min(baseValues) ?? 1), Math.sqrt(max(baseValues) ?? 1)])
      .range(layer.id.startsWith("ntl") ? [2.4, 8.8] : [2.2, 15]);
    const heightScale = scaleLinear()
      .domain([0, Math.sqrt(max(heightValues) ?? 1)])
      .range(layer.id === "buildingFootprint" ? [4, 105] : [4, 190]);

    const columnGroup = new THREE.Group();
    const pickTargets = [];
    const activeValues = values.filter((value) => value != null && Number.isFinite(value));

    for (const row of sceneData.rows) {
      const radius = layer.id === "buildingFootprint" ? 7 : baseScale(Math.sqrt(row.baseValue));
      const height = heightScale(Math.sqrt(row.heightValue));
      const isSelected = row.id === focusId;
      const isHighlighted = highlightedIds.has(row.id);
      const hasHighlightSet = highlightedIds.size > 0;
      const dimmed = hasHighlightSet
        ? !isSelected && !isHighlighted
        : Boolean(focusId) && !isSelected;
      const color = new THREE.Color(colorFor(metric, row.colorValue, activeValues));
      const geometry = new THREE.CylinderGeometry(
        layer.id.startsWith("ntl") ? radius * 0.26 : radius * 0.76,
        radius,
        height,
        layer.id.startsWith("ntl") ? 5 : 7,
        1,
      );
      const material = new THREE.MeshStandardMaterial({
        color: isSelected ? 0xfbbf24 : isHighlighted ? 0x38bdf8 : color,
        emissive: isSelected ? 0x4d3410 : isHighlighted ? 0x123347 : 0x07131d,
        emissiveIntensity: isSelected ? 0.5 : isHighlighted ? 0.38 : 0.16,
        opacity: dimmed ? 0.14 : isHighlighted ? 0.96 : 0.9,
        transparent: true,
        depthWrite: !dimmed,
        roughness: 0.48,
        metalness: 0.18,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(row.x, height / 2, row.z);
      mesh.userData = { id: row.id };
      columnGroup.add(mesh);
      pickTargets.push(mesh);

      if (isSelected || isHighlighted) {
        const ringGeometry = new THREE.TorusGeometry(radius * 1.6, 1.2, 8, 56);
        const ringMaterial = new THREE.MeshBasicMaterial({
          color: isSelected ? 0xfbbf24 : 0x38bdf8,
          transparent: true,
          opacity: isSelected ? 0.92 : 0.55,
        });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(row.x, 1.4, row.z);
        columnGroup.add(ring);

        if (isSelected) {
          const stemGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(row.x, 1, row.z),
            new THREE.Vector3(row.x, height + 18, row.z),
          ]);
          const stemMaterial = new THREE.LineBasicMaterial({
            color: 0xfbbf24,
            transparent: true,
            opacity: 0.86,
          });
          const stem = new THREE.Line(stemGeometry, stemMaterial);
          columnGroup.add(stem);
        }

        const label = createLabelSprite(row.name, isSelected ? "#fbbf24" : "#bae6fd");
        label.position.set(row.x, height + (isSelected ? 30 : 18), row.z);
        columnGroup.add(label);
      }
    }
    scene.add(columnGroup);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const resize = () => {
      const width = Math.max(320, mount.clientWidth);
      const height = Math.max(420, mount.clientHeight);
      renderer.setSize(width, height, false);
      const aspect = width / height;
      const viewHeight = 560;
      const viewWidth = viewHeight * aspect;
      camera.left = -viewWidth / 2;
      camera.right = viewWidth / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      camera.updateProjectionMatrix();
    };

    const pick = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(pickTargets, false)[0]?.object ?? null;
    };

    const handlePointerMove = (event) => {
      renderer.domElement.style.cursor = pick(event) ? "pointer" : "grab";
    };

    const handleClick = (event) => {
      const target = pick(event);
      if (target?.userData.id) setSelectedId(target.userData.id);
    };

    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("click", handleClick);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let animationFrame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => {
              if (material.map) material.map.dispose();
              material.dispose();
            });
          } else {
            if (object.material.map) object.material.map.dispose();
            object.material.dispose();
          }
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [focusId, highlightedIds, layer, metric, sceneData, setSelectedId, values]);

  return (
    <div className="built-scene">
      <div className="built-scene-canvas" ref={mountRef} />
      {selectedRow && (
        <div className="built-scene-readout">
          <span>{selectedRow.state}</span>
          <strong>{selectedRow.name}</strong>
          <div>
            <b>{formatCompact(selectedRow.primaryValue)}</b>
            <small>{selectedRow.primaryLabel}</small>
          </div>
          <div>
            <b>{selectedRow.secondaryValue == null ? "NA" : formatCompact(selectedRow.secondaryValue)}</b>
            <small>{selectedRow.secondaryLabel}</small>
          </div>
        </div>
      )}
    </div>
  );
}

function DistrictMap({
  districts,
  metric,
  recordsById,
  selectedId,
  setSelectedId,
  values,
  year,
}) {
  const { path, features } = useMemo(() => {
    const projection = geoMercator().fitSize([MAP_WIDTH, MAP_HEIGHT], districts);
    return {
      path: geoPath(projection),
      features: districts.features,
    };
  }, [districts]);

  return (
    <div className="map-frame">
      <svg aria-label="India district map" className="district-map" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}>
        <g>
          {features.map((district) => {
            const id = district.properties.id;
            const record = recordsById.get(id);
            const value = metricValue(record, metric, year);
            const fill = colorFor(metric, value, values);
            return (
              <path
                className={id === selectedId ? "district selected" : "district"}
                d={path(district)}
                fill={fill}
                key={id}
                onClick={() => setSelectedId(id)}
              >
                <title>{record ? `${record.name}, ${record.state}: ${metric.formatter(value)}` : id}</title>
              </path>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function DistrictDetail({ layer, metric, record, year }) {
  const annual = record?.annual ?? {};
  const hasData = useMemo(() => {
    return record ? layerValues(record, layer, year) != null : false;
  }, [layer, record, year]);
  const lineData = useMemo(() => {
    return Object.entries(annual)
      .map(([nextYear]) => ({ year: nextYear, value: metricValue(record, metric, nextYear) }))
      .filter((item) => item.value != null);
  }, [annual, metric, record]);

  if (!record) return null;

  const activeValue = hasData ? metricValue(record, metric, year) : null;
  const activeAnnual = annual[year] ?? {};

  return (
    <div className="panel-card detail-card">
      <h2>{record.name}</h2>
      <p>{record.state}</p>
      
      {!hasData ? (
        <div className="no-data-notice">
          <p>
            No satellite panel records mapped for this district. 
            This is typical for administrative regions created after the 2011 Census, 
            coastal boundary discrepancies, or remote island territories.
          </p>
        </div>
      ) : (
        <>
          <div className="detail-value">
            <span>{metric.unit ? `${metric.label} (${metric.unit})` : metric.label}</span>
            <strong>{metric.formatter(activeValue)}</strong>
          </div>
          {lineData.length > 0 && <Sparkline data={lineData} />}
          {layer.id.startsWith("ntl") ? (
            <>
              <MetricLine label="NTL volume" value={formatCompact(activeAnnual.ntlSum)} />
              <MetricLine label="NTL density" value={formatDecimal(activeAnnual.ntlDensity)} />
              <MetricLine label="NTL growth, 2019-2025" value={formatPercent(record.metrics.ntlRecent)} />
              <MetricLine label="NTL gain, 2019-2025" value={formatCompact(record.metrics.ntlGain)} />
              <MetricLine label="Selected year" value={year} />
            </>
          ) : (
            <>
              <MetricLine label="Building footprint" value={formatCompact(activeAnnual.footprintM2)} />
              <MetricLine label="Building volume" value={formatCompact(activeAnnual.volumeM3)} />
              <MetricLine label="Mean modeled height" value={formatHeight(activeAnnual.meanHeightM)} />
              <MetricLine label="Footprint growth" value={formatPercent(record.metrics.footprintGrowth)} />
              <MetricLine label="Volume growth" value={formatPercent(record.metrics.volumeGrowth)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function MetricLine({ label, value }) {
  return (
    <div className="metric-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Sparkline({ data }) {
  const points = useMemo(() => {
    if (!data.length) return "";
    const xScale = scaleLinear().domain([0, data.length - 1]).range([10, 230]);
    const yScale = scaleLinear()
      .domain([min(data, (item) => item.value) ?? 0, max(data, (item) => item.value) ?? 1])
      .range([66, 10]);
    return data.map((item, index) => `${xScale(index)},${yScale(item.value)}`).join(" ");
  }, [data]);

  return (
    <svg className="sparkline" viewBox="0 0 240 76">
      <polyline fill="none" points={points} stroke={PALETTE.gold} strokeWidth="3" />
    </svg>
  );
}

function RankingPanel({ formatter, rankedRecords, title }) {
  const top = rankedRecords.slice(0, 8);
  const maxValue = max(top, (item) => Math.abs(item.value)) ?? 1;
  return (
    <div className="panel-card">
      <h3>{title}</h3>
      <div className="ranking-list">
        {top.map(({ record, value }) => (
          <div className="ranking-row" key={`${title}-${record.id}`}>
            <span title={record.name}>{record.name}</span>
            <i>
              <b style={{ width: `${Math.max(3, (Math.abs(value) / maxValue) * 100)}%` }} />
            </i>
            <strong>{formatter(value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemporalMaps({ districts, recordsById }) {
  const metric = METRICS[0];
  return (
    <section className="panel-section">
      <div className="section-title">
        <h2>NTL volume over time</h2>
        <p>Same scale family, repeated across years. This is the cleanest way to read broad spatial change.</p>
      </div>
      <div className="temporal-grid">
        {TEMPORAL_YEARS.map((year) => (
          <MiniMap
            districts={districts}
            key={year}
            metric={metric}
            recordsById={recordsById}
            title={year}
            year={year}
          />
        ))}
      </div>
    </section>
  );
}

function MiniMap({ districts, metric, recordsById, title, year }) {
  const { path, features } = useMemo(() => {
    const projection = geoMercator().fitSize([260, 210], districts);
    return { path: geoPath(projection), features: districts.features };
  }, [districts]);

  const values = useMemo(
    () => Array.from(recordsById.values()).map((record) => metricValue(record, metric, year)),
    [recordsById, metric, year],
  );

  return (
    <div className="mini-map-card">
      <h3>{title}</h3>
      <svg viewBox="0 0 260 210">
        {features.map((district) => {
          const record = recordsById.get(district.properties.id);
          const value = metricValue(record, metric, year);
          return (
            <path
              className="mini-district"
              d={path(district)}
              fill={colorFor(metric, value, values)}
              key={`${year}-${district.properties.id}`}
            />
          );
        })}
      </svg>
    </div>
  );
}

function scatterPointClass(id, focusId, highlightedIds) {
  if (id === focusId) return "scatter-point focused";
  if (highlightedIds.has(id)) return "scatter-point highlighted";
  if (highlightedIds.size > 0 || focusId) return "scatter-point dimmed";
  return "scatter-point";
}

function scatterLabelClass(id, focusId, highlightedIds) {
  if (id === focusId) return "scatter-label focused";
  if (highlightedIds.has(id)) return "scatter-label highlighted";
  return "scatter-label";
}

function shouldLabelPoint(record, labelSet, focusId, highlightedIds) {
  if (record.id === focusId) return true;
  if (highlightedIds.has(record.id)) return true;
  return highlightedIds.size === 0 && labelSet.has(record.name);
}

function ScatterPanel({ highlightedIds, hoveredId, records, selectedId, setHoveredId, setSelectedId }) {
  const points = useMemo(
    () => records.filter((record) => (
      record.name !== "Lakshadweep"
      && record.metrics.ntlRecent != null
      && record.metrics.footprintGrowth != null
    )),
    [records],
  );
  const xDomain = [
    Math.min(-0.025, min(points, (item) => item.metrics.footprintGrowth) ?? 0),
    Math.max(0.07, max(points, (item) => item.metrics.footprintGrowth) ?? 0.07),
  ];
  const yDomain = [
    Math.min(-0.04, min(points, (item) => item.metrics.ntlRecent) ?? 0),
    Math.max(0.18, max(points, (item) => item.metrics.ntlRecent) ?? 0.18),
  ];
  const xScale = scaleLinear().domain(xDomain).range([52, 520]);
  const yScale = scaleLinear().domain(yDomain).range([300, 24]);
  const labelSet = new Set(["Bangalore Rural", "Krishnagiri", "Rangareddy", "Pune", "Khordha", "Hyderabad"]);
  const focusId = selectedId ?? hoveredId;

  return (
    <section className="panel-section">
      <div className="section-title">
        <h2>Activity growth versus built-form growth</h2>
        <p>Districts above zero on both axes combine rising activity and physical expansion.</p>
      </div>
      <svg className="scatterplot" viewBox="0 0 560 340">
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`x-${index}`}
            x1={52 + index * 93.6}
            x2={52 + index * 93.6}
            y1="24"
            y2="300"
          />
        ))}
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`y-${index}`}
            x1="52"
            x2="520"
            y1={24 + index * 55.2}
            y2={24 + index * 55.2}
          />
        ))}
        <line className="axis-zero" x1={xScale(0)} x2={xScale(0)} y1="24" y2="300" />
        <line className="axis-zero" x1="52" x2="520" y1={yScale(0)} y2={yScale(0)} />
        {points.map((record) => {
          return (
          <circle
            className={scatterPointClass(record.id, focusId, highlightedIds)}
            cx={xScale(record.metrics.footprintGrowth)}
            cy={yScale(record.metrics.ntlRecent)}
            fill={colorFor(METRICS[4], record.metrics.agglomerationSpeed, [])}
            key={record.id}
            onClick={() => {
              setSelectedId(record.id);
              setHoveredId(null);
            }}
            onFocus={() => setHoveredId(record.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") setSelectedId(record.id);
            }}
            onMouseEnter={() => setHoveredId(record.id)}
            onMouseLeave={() => setHoveredId(null)}
            r={2.3 + (record.metrics.agglomerationSpeed ?? 0) * 4}
            role="button"
            tabIndex="0"
          >
            <title>{`${record.name}, ${record.state}: footprint growth ${formatPercent(record.metrics.footprintGrowth)}, NTL growth ${formatPercent(record.metrics.ntlRecent)}`}</title>
          </circle>
          );
        })}
        {points.filter((record) => shouldLabelPoint(record, labelSet, focusId, highlightedIds)).map((record) => (
          <text
            className={scatterLabelClass(record.id, focusId, highlightedIds)}
            key={`label-${record.id}`}
            x={xScale(record.metrics.footprintGrowth) + 7}
            y={yScale(record.metrics.ntlRecent) - 5}
          >
            {record.name}
          </text>
        ))}
        <text className="axis-label" x="286" y="328">Building footprint growth</text>
        <text className="axis-label" transform="rotate(-90 16 166)" x="16" y="166">NTL growth, 2019-2025</text>
      </svg>
    </section>
  );
}

function FootprintVolumePanel({ highlightedIds, hoveredId, records, selectedId, setHoveredId, setSelectedId }) {
  const points = useMemo(
    () => records
      .map((record) => ({
        id: record.id,
        name: record.name,
        state: record.state,
        footprint: record.annual?.[BUILT_FORM_YEAR]?.footprintM2,
        volume: record.annual?.[BUILT_FORM_YEAR]?.volumeM3,
      }))
      .filter((record) => Number.isFinite(record.footprint) && Number.isFinite(record.volume)),
    [records],
  );

  const xDomain = [
    min(points, (item) => Math.sqrt(item.footprint)) ?? 0,
    max(points, (item) => Math.sqrt(item.footprint)) ?? 1,
  ];
  const yDomain = [
    min(points, (item) => Math.sqrt(item.volume)) ?? 0,
    max(points, (item) => Math.sqrt(item.volume)) ?? 1,
  ];
  const xScale = scaleLinear().domain(xDomain).range([52, 520]);
  const yScale = scaleLinear().domain(yDomain).range([300, 24]);
  const labelSet = new Set(["Bangalore", "Rangareddy", "Pune", "Ahmadabad", "Thane", "Mumbai Suburban"]);
  const focusId = selectedId ?? hoveredId;

  return (
    <section className="panel-section">
      <div className="section-title">
        <h2>Footprint and volume</h2>
        <p>Square-root scaled district totals for the latest built-form year.</p>
      </div>
      <svg className="scatterplot" viewBox="0 0 560 340">
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`fv-x-${index}`}
            x1={52 + index * 93.6}
            x2={52 + index * 93.6}
            y1="24"
            y2="300"
          />
        ))}
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`fv-y-${index}`}
            x1="52"
            x2="520"
            y1={24 + index * 55.2}
            y2={24 + index * 55.2}
          />
        ))}
        {points.map((record) => {
          return (
          <circle
            className={scatterPointClass(record.id, focusId, highlightedIds)}
            cx={xScale(Math.sqrt(record.footprint))}
            cy={yScale(Math.sqrt(record.volume))}
            fill="#fbbf24"
            fillOpacity="0.64"
            key={record.id}
            onClick={() => {
              setSelectedId(record.id);
              setHoveredId(null);
            }}
            onFocus={() => setHoveredId(record.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") setSelectedId(record.id);
            }}
            onMouseEnter={() => setHoveredId(record.id)}
            onMouseLeave={() => setHoveredId(null)}
            r="4"
            role="button"
            tabIndex="0"
          >
            <title>{`${record.name}, ${record.state}: footprint ${formatCompact(record.footprint)}, volume ${formatCompact(record.volume)}`}</title>
          </circle>
          );
        })}
        {points.filter((record) => shouldLabelPoint(record, labelSet, focusId, highlightedIds)).map((record) => (
          <text
            className={scatterLabelClass(record.id, focusId, highlightedIds)}
            key={`fv-label-${record.id}`}
            x={xScale(Math.sqrt(record.footprint)) + 7}
            y={yScale(Math.sqrt(record.volume)) - 5}
          >
            {record.name}
          </text>
        ))}
        <text className="axis-label" x="286" y="328">Building footprint</text>
        <text className="axis-label" transform="rotate(-90 16 166)" x="16" y="166">Building volume</text>
      </svg>
    </section>
  );
}

function NtlDensityVolumePanel({ highlightedIds, hoveredId, records, selectedId, setHoveredId, setSelectedId, year }) {
  const points = useMemo(
    () => records
      .map((record) => ({
        id: record.id,
        name: record.name,
        state: record.state,
        density: record.annual?.[year]?.ntlDensity,
        volume: record.annual?.[year]?.ntlSum,
      }))
      .filter((record) => Number.isFinite(record.density) && record.density >= 0 && Number.isFinite(record.volume) && record.volume >= 0),
    [records, year],
  );

  const xDomain = [
    min(points, (item) => Math.sqrt(item.density)) ?? 0,
    max(points, (item) => Math.sqrt(item.density)) ?? 1,
  ];
  const yDomain = [
    min(points, (item) => Math.sqrt(item.volume)) ?? 0,
    max(points, (item) => Math.sqrt(item.volume)) ?? 1,
  ];
  const xScale = scaleLinear().domain(xDomain).range([52, 520]);
  const yScale = scaleLinear().domain(yDomain).range([300, 24]);
  const labelSet = new Set(["Hyderabad", "Mumbai", "Kolkata", "Chennai", "Bangalore", "Pune"]);
  const focusId = selectedId ?? hoveredId;

  return (
    <section className="panel-section">
      <div className="section-title">
        <h2>NTL density and volume</h2>
        <p>{year} district light intensity against total nighttime-light volume.</p>
      </div>
      <svg className="scatterplot" viewBox="0 0 560 340">
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`ntl-x-${index}`}
            x1={52 + index * 93.6}
            x2={52 + index * 93.6}
            y1="24"
            y2="300"
          />
        ))}
        {Array.from({ length: 6 }, (_, index) => (
          <line
            className="gridline"
            key={`ntl-y-${index}`}
            x1="52"
            x2="520"
            y1={24 + index * 55.2}
            y2={24 + index * 55.2}
          />
        ))}
        {points.map((record) => {
          return (
            <circle
              className={scatterPointClass(record.id, focusId, highlightedIds)}
              cx={xScale(Math.sqrt(record.density))}
              cy={yScale(Math.sqrt(record.volume))}
              fill="#60a5fa"
              fillOpacity="0.66"
              key={record.id}
              onClick={() => {
                setSelectedId(record.id);
                setHoveredId(null);
              }}
              onFocus={() => setHoveredId(record.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") setSelectedId(record.id);
              }}
              onMouseEnter={() => setHoveredId(record.id)}
              onMouseLeave={() => setHoveredId(null)}
              r="4"
              role="button"
              tabIndex="0"
            >
              <title>{`${record.name}, ${record.state}: NTL density ${formatDecimal(record.density)}, NTL volume ${formatCompact(record.volume)}`}</title>
            </circle>
          );
        })}
        {points.filter((record) => shouldLabelPoint(record, labelSet, focusId, highlightedIds)).map((record) => (
          <text
            className={scatterLabelClass(record.id, focusId, highlightedIds)}
            key={`ntl-label-${record.id}`}
            x={xScale(Math.sqrt(record.density)) + 7}
            y={yScale(Math.sqrt(record.volume)) - 5}
          >
            {record.name}
          </text>
        ))}
        <text className="axis-label" x="286" y="328">NTL density</text>
        <text className="axis-label" transform="rotate(-90 16 166)" x="16" y="166">NTL volume</text>
      </svg>
    </section>
  );
}

function MethodCard({ title, text }) {
  return (
    <div className="method-card">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
