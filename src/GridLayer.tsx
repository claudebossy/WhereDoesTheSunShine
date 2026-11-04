import { useMemo } from 'react';
import { CircleMarker, ImageOverlay, Pane, useMapEvents } from 'react-leaflet';
import { gridCell, rasterPixels, type ForecastGrid } from './grid';

export interface GridPoint { latitude: number; longitude: number }

export default function GridLayer({ grid, minimumElevation, sunnyOnly, selected, onSelect }: {
  grid?: ForecastGrid;
  minimumElevation: number;
  sunnyOnly: boolean;
  selected?: GridPoint;
  onSelect: (point: GridPoint) => void;
}) {
  useMapEvents({
    click: ({ latlng }) => {
      if (grid && gridCell(grid, latlng.lat, latlng.lng) !== undefined) {
        onSelect({ latitude: latlng.lat, longitude: latlng.lng });
      }
    },
  });
  const image = useMemo(() => {
    if (!grid) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser does not support the forecast map canvas.');
    const pixels = context.createImageData(grid.width, grid.height);
    pixels.data.set(rasterPixels(grid, minimumElevation, sunnyOnly));
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  }, [grid, minimumElevation, sunnyOnly]);
  return <>
    <Pane name="native-forecast" style={{ zIndex: 350, pointerEvents: 'none' }}>
      {grid && image && <ImageOverlay url={image} bounds={grid.bounds} className="forecast-raster" />}
    </Pane>
    {grid && selected && <CircleMarker center={[selected.latitude, selected.longitude]} radius={6} interactive={false} pathOptions={{ color: '#fff', weight: 2, fillColor: '#283f33', fillOpacity: 1 }} />}
  </>;
}
