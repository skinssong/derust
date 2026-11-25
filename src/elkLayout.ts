import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge } from 'elkjs/lib/elk-api';
import { ArchitectureModel } from './architecture';

export type RouteSegments = { w: number[]; d: number[] };

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.nodeNode': '50',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.edgeNode': '30',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.spacing.edgeEdge': '20',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '20'
};

const elk = new ELK();

/** Lay the model out with ELK's layered algorithm and orthogonal edge
 * routing. Positions are node centres; bend points are converted to the
 * segment weights/distances Cytoscape's `round-segments` edges expect. */
export async function layoutArchitecture(
  model: ArchitectureModel
): Promise<ArchitectureModel> {
  if (model.nodes.length === 0) {
    return model;
  }
  const pairs = uniquePairs(model.edges);
  const laidOut = await elk.layout(
    {
      id: 'root',
      children: model.nodes.map((node) => ({
        id: node.id,
        width: node.w,
        height: node.h
      })),
      edges: pairs.map((pair) => ({
        id: edgeId(pair.source, pair.target),
        sources: [pair.source],
        targets: [pair.target]
      }))
    },
    { layoutOptions: LAYOUT_OPTIONS }
  );

  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const positions: Record<string, [number, number]> = {};
  for (const child of laidOut.children ?? []) {
    const node = byId.get(child.id);
    if (!node) {
      continue;
    }
    positions[child.id] = [
      Math.round((child.x ?? 0) + node.w / 2),
      Math.round((child.y ?? 0) + node.h / 2)
    ];
  }

  const routes = new Map<string, Array<[number, number]>>();
  for (const edge of (laidOut.edges ?? []) as ElkExtendedEdge[]) {
    const points: Array<[number, number]> = [];
    for (const section of edge.sections ?? []) {
      for (const bend of section.bendPoints ?? []) {
        points.push([bend.x, bend.y]);
      }
    }
    routes.set(edge.id ?? '', points);
  }

  const edges = model.edges.map((edge) => {
    const source = positions[edge.source];
    const target = positions[edge.target];
    if (!source || !target) {
      return { ...edge, segW: [], segD: [] };
    }
    const segments = routeToSegments(
      source,
      target,
      routes.get(edgeId(edge.source, edge.target)) ?? []
    );
    return { ...edge, segW: segments.w, segD: segments.d };
  });

  return { ...model, positions, edges };
}

/** Convert world-space bend points to pairs of (weight, distance) relative
 * to the line from the source to the target node position. */
export function routeToSegments(
  source: [number, number],
  target: [number, number],
  points: Array<[number, number]>
): RouteSegments {
  const [sx, sy] = source;
  const [tx, ty] = target;
  const ux = tx - sx;
  const uy = ty - sy;
  const length = Math.hypot(ux, uy) || 1;
  const length2 = length * length;
  const nx = -uy / length;
  const ny = ux / length;
  const w: number[] = [];
  const d: number[] = [];
  for (const [px, py] of points) {
    const dx = px - sx;
    const dy = py - sy;
    w.push(Number(((dx * ux + dy * uy) / length2).toFixed(4)));
    d.push(Number((dx * nx + dy * ny).toFixed(2)));
  }
  return { w, d };
}

function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

function uniquePairs(
  edges: ArchitectureModel['edges']
): Array<{ source: string; target: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ source: string; target: string }> = [];
  for (const edge of edges) {
    const key = edgeId(edge.source, edge.target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pairs.push({ source: edge.source, target: edge.target });
  }
  return pairs;
}
