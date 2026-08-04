import type { MonitoringData } from '@nzxt/web-integrations-types/v1';
import { readDisplayMetrics } from '../core/display';

export interface Telemetry {
  cpuTempC?: number;
  /** 0..1, not a percentage. */
  cpuLoad?: number;
  gpuTempC?: number;
  liquidTempC?: number;
}

export function adaptMonitoring(data: MonitoringData | undefined): Telemetry {
  const cpu = data?.cpus?.[0];
  const gpu = data?.gpus?.[0];
  return {
    cpuTempC: cpu?.temperature,
    cpuLoad: cpu?.load,
    gpuTempC: gpu?.temperature,
    liquidTempC: data?.kraken?.liquidTemperature,
  };
}

/**
 * CAM has already populated `window.nzxt.v1` with the display attributes, so
 * only the callback may be assigned — replacing the object would drop them.
 */
export function installMonitoring(onUpdate: (t: Telemetry) => void): void {
  window.nzxt = window.nzxt ?? {};
  if (!window.nzxt.v1) {
    const m = readDisplayMetrics();
    window.nzxt.v1 = {
      width: m.width,
      height: m.height,
      shape: m.shape,
      targetFps: m.targetFps,
    };
  }
  window.nzxt.v1.onMonitoringDataUpdate = (data) => {
    try {
      onUpdate(adaptMonitoring(data));
    } catch (err) {
      console.error('[nzxt] monitoring update failed', err);
    }
  };
}
