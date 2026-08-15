/**
 * In-memory Organization graph store (Hermes v1 — not persisted).
 *
 * Holds profiles, runs, execution nodes, and edges. Populated by the
 * HermesProvider from each bridge board frame; snapshotted into the `orgState`
 * ServerMessage broadcast to every connected webview client.
 */

import type {
  EdgeRelation,
  ExecutionEdge,
  ExecutionNode,
  ProfileController,
  Run,
} from './providers/hermes/orgModel.js';

/** Serializable snapshot broadcast as the `orgState` message payload. */
export interface OrgSnapshot {
  profiles: ProfileController[];
  runs: Run[];
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
}

export class OrgStore {
  readonly profiles = new Map<string, ProfileController>();
  readonly runs = new Map<string, Run>();
  readonly nodes = new Map<string, ExecutionNode>();
  readonly edges = new Map<string, ExecutionEdge>();

  upsertProfile(profile: ProfileController): void {
    this.profiles.set(profile.profileId, profile);
  }

  upsertRun(run: Run): void {
    this.runs.set(run.id, run);
  }

  upsertNode(node: ExecutionNode): void {
    this.nodes.set(node.id, node);
  }

  upsertEdge(edge: ExecutionEdge): void {
    this.edges.set(edge.id, edge);
  }

  /** Connect a parent node to a child node with a relation. */
  connect(parentId: string, childId: string, relation: EdgeRelation): void {
    const runId = this.nodes.get(childId)?.runId ?? this.nodes.get(parentId)?.runId;
    if (runId === undefined) return;
    this.upsertEdge({
      id: `${parentId}->${childId}`,
      runId,
      fromNodeId: parentId,
      toNodeId: childId,
      relation,
    });
  }

  /** Return all nodes + edges belonging to a run (including transitive children). */
  getGraph(runId: string): { nodes: ExecutionNode[]; edges: ExecutionEdge[] } {
    const nodes = [...this.nodes.values()].filter((n) => n.runId === runId);
    const edges = [...this.edges.values()].filter((e) => e.runId === runId);
    return { nodes, edges };
  }

  /** Full graph snapshot for the `orgState` broadcast. */
  snapshot(): OrgSnapshot {
    return {
      profiles: [...this.profiles.values()],
      runs: [...this.runs.values()],
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    };
  }

  /** Remove every profile/run/node/edge. */
  clear(): void {
    this.profiles.clear();
    this.runs.clear();
    this.nodes.clear();
    this.edges.clear();
  }
}
