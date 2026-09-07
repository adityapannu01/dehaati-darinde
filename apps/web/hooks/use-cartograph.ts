'use client';

import { useEffect, useRef, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { useSessionContext } from '@livekit/components-react';
import {
  CARTOGRAPH_TOPIC,
  type CanvasEdge,
  type CanvasNode,
  type FormingElement,
  type LedgerEvent,
  type ServerMessage,
} from '@repo/protocol';

const MAX_EVENTS = 200;

export interface CartographStatus {
  generation: number;
  ttsProvider: string;
  llmEngine: string;
  baselineMode: boolean;
  speaking: boolean;
  toolRunning: boolean;
  heardText: string;
  spokenText: string;
  pendingText: string;
}

/** A staged-but-uncommitted element plus whether its naming word has been spoken yet (§3.3). */
export interface FormingState extends FormingElement {
  /** true once a delivered word matched this element's anchorPhrase. */
  named: boolean;
}

export interface UseCartographReturn {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  events: LedgerEvent[];
  status: CartographStatus | undefined;
  /** Elements the agent has staged for the current turn but not yet committed. */
  forming: FormingState[];
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
  const [forming, setForming] = useState<FormingState[]>([]);
  const lastVersion = useRef(0);
  const decoderRef = useRef<TextDecoder | undefined>(undefined);
  // Words delivered in the current generation, lowercased — used to flip a
  // forming element to `named` when its anchor phrase is spoken.
  const spokenRef = useRef<{ generation: number; text: string }>({ generation: 0, text: '' });

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
        case 'word': {
          const s = spokenRef.current;
          if (msg.generation !== s.generation) {
            spokenRef.current = { generation: msg.generation, text: msg.text.toLowerCase() };
          } else {
            spokenRef.current = { generation: s.generation, text: `${s.text} ${msg.text.toLowerCase()}` };
          }
          const heard = spokenRef.current.text;
          setForming((prev) =>
            prev.map((f) =>
              f.named || !heard.includes(f.anchorPhrase.toLowerCase()) ? f : { ...f, named: true }
            )
          );
          break;
        }
        case 'staging': {
          if (msg.generation !== spokenRef.current.generation) {
            spokenRef.current = { generation: msg.generation, text: '' };
          }
          const heard = spokenRef.current.text;
          setForming(
            msg.elements.map((el) => ({
              ...el,
              named: heard.includes(el.anchorPhrase.toLowerCase()),
            }))
          );
          break;
        }
        case 'status':
          setStatus({
            generation: msg.generation,
            ttsProvider: msg.ttsProvider,
            llmEngine: msg.llmEngine,
            baselineMode: msg.baselineMode,
            speaking: msg.speaking,
            toolRunning: msg.toolRunning,
            heardText: msg.heardText,
            spokenText: msg.spokenText,
            pendingText: msg.pendingText,
          });
          break;
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room]);

  return { nodes, edges, events, status, forming };
}
