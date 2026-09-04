'use client';

import { useEffect, useRef, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { useSessionContext } from '@livekit/components-react';
import {
  CARTOGRAPH_TOPIC,
  type CanvasEdge,
  type CanvasNode,
  type LedgerEvent,
  type ServerMessage,
} from '@repo/protocol';

const MAX_EVENTS = 200;

export interface CartographStatus {
  generation: number;
  ttsProvider: string;
  baselineMode: boolean;
  speaking: boolean;
  toolRunning: boolean;
  heardText: string;
}

export interface UseCartographReturn {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  events: LedgerEvent[];
  status: CartographStatus | undefined;
}

/**
 * Consumes the agent's `cartograph`-topic data channel messages (see
 * apps/agent/src/transport/publisher.ts) and exposes render-ready state.
 * The agent owns the canvas; this hook only ever renders what it publishes.
 */
export function useCartograph(): UseCartographReturn {
  const { room } = useSessionContext();
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [status, setStatus] = useState<CartographStatus | undefined>(undefined);
  const lastVersion = useRef(0);
  const decoderRef = useRef<TextDecoder | undefined>(undefined);

  useEffect(() => {
    if (!room) return;

    const handleData = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== CARTOGRAPH_TOPIC) return;

      decoderRef.current ??= new TextDecoder();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(decoderRef.current.decode(payload)) as ServerMessage;
      } catch {
        return; // malformed packet; ignore rather than crash the render
      }

      switch (msg.kind) {
        case 'snapshot':
          // Drop out-of-order snapshots — reliable delivery doesn't guarantee ordering
          // across separate publishData calls under load.
          if (msg.snapshot.version <= lastVersion.current) return;
          lastVersion.current = msg.snapshot.version;
          setNodes(msg.snapshot.nodes);
          setEdges(msg.snapshot.edges);
          break;
        case 'events':
          setEvents((prev) => [...prev, ...msg.events].slice(-MAX_EVENTS));
          break;
        case 'status':
          setStatus({
            generation: msg.generation,
            ttsProvider: msg.ttsProvider,
            baselineMode: msg.baselineMode,
            speaking: msg.speaking,
            toolRunning: msg.toolRunning,
            heardText: msg.heardText,
          });
          break;
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room]);

  return { nodes, edges, events, status };
}
