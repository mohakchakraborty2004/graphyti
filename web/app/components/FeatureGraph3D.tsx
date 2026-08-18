'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import { useRef, useMemo } from 'react';
import * as THREE from 'three';

const NODE_POSITIONS: [number, number, number][] = [
  [0, 0, 0],
  [1.5, 0.8, 0.3],
  [-1.2, 1.0, -0.5],
  [0.8, -1.0, 0.2],
  [-0.6, -0.7, 1.0],
  [1.0, 0.3, -1.0],
  [-1.5, -0.2, -0.8],
  [0.3, 1.3, 0.7],
  [-0.9, 0.5, 1.2],
  [1.3, -0.6, -0.4],
];

const EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 5], [1, 7],
  [2, 6], [2, 8],
  [3, 9], [3, 4],
  [4, 8],
  [5, 9],
  [6, 8],
];

const VERIFIED_NODES = new Set([0, 1, 3]);
const ORANGE = '#ff6b1a';
const GRAY = '#404040';
const EDGE_REST = '#262626';
const EDGE_HIGHLIGHT = '#ff6b1a';

function RotatingGroup({ children }: { children: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.15;
    }
  });
  return <group ref={groupRef}>{children}</group>;
}

function Node({ position, verified }: { position: [number, number, number]; verified: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (meshRef.current && verified) {
      const pulse = Math.sin(state.clock.elapsedTime * 2 + position[0] * 3) * 0.15 + 0.85;
      meshRef.current.scale.setScalar(pulse);
    }
  });
  return (
    <mesh ref={meshRef} position={position}>
      <sphereGeometry args={[verified ? 0.18 : 0.12, 16, 16]} />
      <meshBasicMaterial color={verified ? ORANGE : GRAY} />
    </mesh>
  );
}

function Edge({ from, to, verified }: { from: [number, number, number]; to: [number, number, number]; verified: boolean }) {
  return (
    <Line
      points={[from, to]}
      color={verified ? EDGE_HIGHLIGHT : EDGE_REST}
      lineWidth={1}
    />
  );
}

function Scene() {
  return (
    <RotatingGroup>
      {NODE_POSITIONS.map((pos, i) => (
        <Node key={i} position={pos} verified={VERIFIED_NODES.has(i)} />
      ))}
      {EDGES.map(([a, b], i) => (
        <Edge
          key={i}
          from={NODE_POSITIONS[a]}
          to={NODE_POSITIONS[b]}
          verified={VERIFIED_NODES.has(a) || VERIFIED_NODES.has(b)}
        />
      ))}
    </RotatingGroup>
  );
}

export function FeatureGraph3D() {
  return (
    <div className="feature-graph-3d">
      <Canvas
        camera={{ position: [0, 0, 4], fov: 40 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true }}
      >
        <Scene />
        <OrbitControls
          enableZoom={false}
          enablePan={false}
          autoRotate={false}
          rotateSpeed={0.5}
        />
      </Canvas>
    </div>
  );
}
