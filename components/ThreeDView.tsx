import React, { useRef, useState, useEffect } from 'react';
import { ZoneParams } from '../types';
import { Box, Layers, Maximize } from 'lucide-react';

interface Props {
  zone: ZoneParams;
}

const ThreeDView: React.FC<Props> = ({ zone }) => {
  const [rotation, setRotation] = useState({ x: 20, y: 45 });
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Scale factor: 1 meter = 40 pixels (approx)
  const widthPx = zone.widthM * 40; 
  const depthPx = zone.lengthM * 40;
  const heightPx = zone.ceilingHeightM * 40;
  
  // Handler for basic mouse rotation
  const handleMouseMove = (e: React.MouseEvent) => {
    if (e.buttons === 1) {
      setRotation(prev => ({
        x: Math.max(0, Math.min(90, prev.x - e.movementY * 0.5)),
        y: prev.y + e.movementX * 0.5
      }));
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
         <h3 className="text-lg font-semibold text-white flex items-center gap-2">
           <Box size={20} className="text-purple-400" />
           3D Thermal Model
         </h3>
         <div className="text-xs text-slate-400">
           Drag to Rotate • Dimensions: {zone.lengthM}m x {zone.widthM}m
         </div>
      </div>

      <div 
        className="relative h-[500px] bg-slate-900 rounded-xl border border-slate-700 overflow-hidden cursor-move flex items-center justify-center perspective-1000"
        onMouseMove={handleMouseMove}
      >
        <div 
           className="relative transform-style-3d transition-transform duration-75 ease-out"
           style={{
             width: `${widthPx}px`,
             height: `${heightPx}px`,
             transform: `rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`
           }}
        >
          {/* Floor */}
          <div 
            className="absolute bg-slate-800 border-2 border-slate-600/50 flex items-center justify-center overflow-hidden backface-visible"
            style={{
              width: `${widthPx}px`,
              height: `${depthPx}px`,
              transform: `rotateX(90deg) translateZ(${heightPx / 2}px)`,
              boxShadow: '0 0 50px rgba(0,0,0,0.5)'
            }}
          >
            <div className="text-slate-600 font-mono text-sm grid place-items-center w-full h-full bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%,#1e293b),linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%,#1e293b)] bg-[length:20px_20px]">
                Floor ({zone.lengthM}m x {zone.widthM}m)
            </div>
          </div>

          {/* Ceiling (Transparent Grid) */}
           <div 
            className="absolute border border-slate-500/20 bg-blue-500/5 pointer-events-none"
            style={{
              width: `${widthPx}px`,
              height: `${depthPx}px`,
              transform: `rotateX(90deg) translateZ(-${heightPx / 2}px)`,
            }}
          />

          {/* Front Wall */}
          <div 
            className="absolute border border-purple-500/30 bg-purple-900/10 backdrop-blur-[1px] flex items-center justify-center text-xs text-purple-300/50"
            style={{
              width: `${widthPx}px`,
              height: `${heightPx}px`,
              transform: `translateZ(${depthPx / 2}px)`,
            }}
          >
            Front
          </div>

          {/* Back Wall */}
          <div 
            className="absolute border border-purple-500/30 bg-purple-900/10 backdrop-blur-[1px]"
            style={{
              width: `${widthPx}px`,
              height: `${heightPx}px`,
              transform: `rotateY(180deg) translateZ(${depthPx / 2}px)`,
            }}
          />

          {/* Right Wall */}
          <div 
            className="absolute border border-purple-500/30 bg-purple-900/10 backdrop-blur-[1px] flex items-center justify-center text-xs text-purple-300/50"
            style={{
              width: `${depthPx}px`,
              height: `${heightPx}px`,
              transform: `rotateY(90deg) translateZ(${widthPx / 2}px)`,
            }}
          >
            Right
          </div>

          {/* Left Wall */}
          <div 
            className="absolute border border-purple-500/30 bg-purple-900/10 backdrop-blur-[1px] flex items-center justify-center text-xs text-purple-300/50"
            style={{
              width: `${depthPx}px`,
              height: `${heightPx}px`,
              transform: `rotateY(-90deg) translateZ(${widthPx / 2}px)`,
            }}
          >
            Left
          </div>

          {/* Internal Equipment Visualizer (Simple Cubes) */}
           <div 
            className="absolute transform-style-3d"
            style={{
              width: '100%', height: '100%',
              transform: `rotateX(90deg) translateZ(${heightPx / 2 - 10}px)` // Place on floor
            }}
          >
             {/* Represent heat load as a glowing core in center */}
             <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 bg-orange-500/20 rounded-full blur-xl animate-pulse"></div>
          </div>

        </div>
      </div>
      
      <div className="grid grid-cols-3 gap-4 text-xs text-slate-400">
         <div className="bg-slate-800 p-2 rounded border border-slate-700">
           <span className="block text-slate-500 uppercase font-bold mb-1">Volume</span>
           {(zone.lengthM * zone.widthM * zone.ceilingHeightM).toFixed(1)} m³
         </div>
         <div className="bg-slate-800 p-2 rounded border border-slate-700">
           <span className="block text-slate-500 uppercase font-bold mb-1">Floor</span>
           {(zone.lengthM * zone.widthM).toFixed(1)} m²
         </div>
         <div className="bg-slate-800 p-2 rounded border border-slate-700">
           <span className="block text-slate-500 uppercase font-bold mb-1">Simulation</span>
           Static Mesh
         </div>
      </div>
      
      <style>{`
        .perspective-1000 { perspective: 1000px; }
        .transform-style-3d { transform-style: preserve-3d; }
        .backface-visible { backface-visibility: visible; }
      `}</style>
    </div>
  );
};

export default ThreeDView;