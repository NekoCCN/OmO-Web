import { el, object, str } from "./dom.ts";
import type { Wire } from "./dom.ts";
import { knownActivityState } from "./native-activity.ts";

// Match the server projection's node limit; at most N * (N - 1) / 2 edges
// survive the strictly earlier-wave and unique-upstream checks.
export const MAX_DAG_NODES = 64;
const svgNS = "http://www.w3.org/2000/svg";
let nextMarker = 0;
type DagNode = { id: number; state: string; upstream: number[] };

function projectedWaves(data: Wire) {
  if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > MAX_DAG_NODES ||
      !Array.isArray(data.waves) || !data.waves.length || data.waves.length > data.nodes.length) return;
  const nodeCount = data.nodes.length;
  const nodes = new Map<number, DagNode>();
  const localIndex = (id: unknown): id is number =>
    typeof id === "number" && Number.isInteger(id) && id >= 0 && id < nodeCount;
  for (const raw of data.nodes) {
    const { id, state, upstream } = object(raw);
    if (!localIndex(id) || nodes.has(id) || !Array.isArray(upstream) || upstream.length >= nodeCount ||
        !upstream.every(localIndex) || new Set(upstream).size !== upstream.length) return;
    nodes.set(id, { id, state: str(state), upstream });
  }
  const positions = new Map<number, number>();
  const waves: DagNode[][] = [];
  for (const [index, raw] of data.waves.entries()) {
    const wave = object(raw);
    if (wave.index !== index || !Array.isArray(wave.nodes) || !wave.nodes.length || wave.nodes.length > nodes.size) return;
    const row: DagNode[] = [];
    for (const id of wave.nodes) {
      if (!localIndex(id) || positions.has(id)) return;
      const node = nodes.get(id);
      if (!node) return;
      positions.set(id, index);
      row.push(node);
    }
    waves.push(row);
  }
  if (positions.size !== nodes.size) return;
  for (const [index, row] of waves.entries()) for (const node of row) {
    if (!node.upstream.every(id => (positions.get(id) ?? Infinity) < index)) return;
  }
  return waves;
}

export function renderDagGraph(data: Wire): HTMLElement | undefined {
  const waves = projectedWaves(data);
  if (!waves) return;
  const cardWidth = 88;
  const cardHeight = 46;
  const gap = 16;
  const inset = 12;
  const waveHeight = 96;
  const headingHeight = 21;
  const rowWidth = (columns: number) => columns * (cardWidth + gap) - gap;
  const widest = rowWidth(Math.max(...waves.map(wave => wave.length)));
  // Keep the first nodes of each wave in the initial viewport, even for a wide wave.
  const originWidth = Math.min(widest, rowWidth(2));
  const boxes = new Map<number, { x: number; y: number; wave: number }>();
  const lanes = new Map<number, number>();
  const map = el("div", "dag-graph-map");
  map.tabIndex = 0;
  map.setAttribute("role", "region");
  map.setAttribute("aria-label", "有向依赖图；可滚动，完整依赖见下方文字列表");
  const canvas = el("div", "dag-graph-canvas");
  const scale = (value: number) => `${value / 16}rem`;

  for (const [wave, row] of waves.entries()) {
    const y = inset + wave * waveHeight;
    const label = el("div", "dag-graph-wave", `第 ${wave + 1} 波`);
    label.style.top = scale(y);
    canvas.append(label);
    for (const [column, node] of row.entries()) {
      const x = inset + Math.max(0, (originWidth - rowWidth(row.length)) / 2) + column * (cardWidth + gap);
      boxes.set(node.id, { x: x + cardWidth / 2, y: y + headingHeight, wave });
      const card = el("div", "dag-graph-node");
      card.dataset.node = String(node.id);
      const label = knownActivityState(node.state);
      if (label) card.dataset.state = node.state;
      card.style.left = scale(x);
      card.style.top = scale(y + headingHeight);
      card.style.width = scale(cardWidth);
      card.style.height = scale(cardHeight);
      card.append(el("strong", "", `节点 ${node.id + 1}`), el("span", "", label ?? "状态未知"));
      canvas.append(card);
    }
  }

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "dag-graph-edges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const defs = document.createElementNS(svgNS, "defs");
  const arrow = document.createElementNS(svgNS, "marker");
  const marker = `dag-arrow-${++nextMarker}`;
  arrow.setAttribute("id", marker);
  arrow.setAttribute("viewBox", "0 0 6 8");
  arrow.setAttribute("markerWidth", "6");
  arrow.setAttribute("markerHeight", "8");
  arrow.setAttribute("markerUnits", "userSpaceOnUse");
  arrow.setAttribute("refX", "6");
  arrow.setAttribute("refY", "4");
  arrow.setAttribute("orient", "auto");
  const tip = document.createElementNS(svgNS, "path");
  tip.setAttribute("d", "M0 0 L6 4 L0 8 Z");
  arrow.append(tip);
  defs.append(arrow);
  svg.append(defs);

  for (const row of waves) for (const node of row) {
    const to = boxes.get(node.id)!;
    for (const id of node.upstream) {
      const from = boxes.get(id)!;
      const bottom = from.y + cardHeight;
      const end = to.y - 2;
      const edge = document.createElementNS(svgNS, "path");
      edge.dataset.from = String(id);
      edge.dataset.to = String(node.id);
      edge.setAttribute("marker-end", `url(#${marker})`);
      if (to.wave === from.wave + 1) {
        const middle = (bottom + end) / 2;
        edge.setAttribute("d", `M${from.x} ${bottom} C${from.x} ${middle} ${to.x} ${middle} ${to.x} ${end}`);
      } else {
        // Route wave-skipping edges outside intermediate cards, not through them.
        const lane = lanes.get(id) ?? lanes.size;
        lanes.set(id, lane);
        const side = inset + widest + 8 + 5 * lane;
        edge.setAttribute("d", `M${from.x} ${bottom} V${bottom + 6} H${side} V${end - 9} H${to.x} V${end}`);
      }
      svg.append(edge);
    }
  }
  const width = 2 * inset + widest + lanes.size * 5;
  const height = 2 * inset + (waves.length - 1) * waveHeight + headingHeight + cardHeight;
  canvas.style.width = scale(width);
  canvas.style.height = scale(height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  canvas.prepend(svg);
  map.append(canvas);
  return map;
}
