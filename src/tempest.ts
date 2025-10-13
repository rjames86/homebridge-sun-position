import axios from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

const BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const STATION_OBSERVATION_URL = (stationId: string) => `${BASE_URL}/observations/station/${stationId}`;
const STATION_METADATA_URL = (stationId: string) => `${BASE_URL}/stations/${stationId}`;
const WEBSOCKET_URL = 'wss://ws.weatherflow.com/swd/data';

interface TempestObservationData {
  obs: Array<{
    air_temperature: number;
    brightness: number;
    relative_humidity: number;
    barometric_pressure: number;
    wind_avg: number;
    wind_direction: number;
    solar_radiation: number;
    uv: number;
    timestamp: number;
    [key: string]: unknown; // For other fields we might not use
  }>;
  station_units: {
    units_temp: string;
    units_other: string;
    [key: string]: string;
  };
}

interface WebSocketObservation {
  type: 'obs_st';
  device_id: number;
  obs: number[][];
}

interface WebSocketMessage {
  type: string;
  device_id?: number;
  obs?: number[][];
  [key: string]: unknown;
}

interface StationMetadata {
  stations: Array<{
    station_id: number;
    name: string;
    devices: Array<{
      device_id: number;
      device_type: string;
      device_meta: {
        agl: number;
        name: string;
      };
    }>;
  }>;
}

export class Observations {
  private tempestData?: TempestObservationData;
  private observation?: TempestObservationData['obs'][0];
  private wsObservation?: WebSocketObservation;

  constructor(data: TempestObservationData | WebSocketObservation) {
    if ('obs' in data && Array.isArray(data.obs) && data.obs.length > 0) {
      // Check if this is HTTP API data (obs[0] is an object) or WebSocket data (obs[0] is an array)
      if (typeof data.obs[0] === 'object' && !Array.isArray(data.obs[0])) {
        // HTTP API data
        this.tempestData = data as TempestObservationData;
        this.observation = this.tempestData.obs[0];
      } else {
        // WebSocket data
        this.wsObservation = data as WebSocketObservation;
      }
    }
  }

  get airTemperature(): number {
    let temp: number;

    if (this.observation) {
      // HTTP API data
      temp = this.observation.air_temperature;
    } else if (this.wsObservation && this.wsObservation.obs.length > 0) {
      // WebSocket data - air temperature is at index 7 in the first obs array
      temp = this.wsObservation.obs[0][7];
    } else {
      return 20; // Default temperature
    }

    return Math.round(temp * 100) / 100; // Round to 2 decimal places
  }

  get lux(): number {
    if (this.observation) {
      // HTTP API data
      return this.observation.brightness;
    } else if (this.wsObservation && this.wsObservation.obs.length > 0) {
      // WebSocket data - brightness is at index 9 in the first obs array
      return this.wsObservation.obs[0][9];
    }
    return 0.0001; // Default lux value
  }
}

export class Tempest extends EventEmitter {
  private token: string;
  private ws?: WebSocket;
  private baseReconnectInterval = 5000; // 5 seconds
  private currentReconnectInterval = 5000;
  private maxReconnectInterval = 300000; // 5 minutes
  private reconnectTimer?: NodeJS.Timeout;
  private isConnecting = false;
  private consecutiveFailures = 0;
  private maxRetries = 10;

  constructor(token: string) {
    super();
    this.token = token;
  }

  async getStationObservation(stationId: string): Promise<Observations> {
    const response = await this.makeRequest(STATION_OBSERVATION_URL(stationId));
    return new Observations(response);
  }

  async getStationMetadata(stationId: string): Promise<StationMetadata> {
    const { data } = await axios.get<StationMetadata>(STATION_METADATA_URL(stationId), {
      params: {
        token: this.token,
      },
    });
    return data;
  }

  async getTempestDeviceId(stationId: string): Promise<number | null> {
    try {
      const metadata = await this.getStationMetadata(stationId);

      // Look for the Tempest device (device_type: "ST")
      for (const station of metadata.stations) {
        for (const device of station.devices) {
          if (device.device_type === 'ST') {
            return device.device_id;
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  async connectWebSocket(stationId: string): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // First, get the actual device ID
    const deviceId = await this.getTempestDeviceId(stationId);
    if (!deviceId) {
      return;
    }

    this.isConnecting = true;
    const wsUrl = `${WEBSOCKET_URL}?token=${this.token}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.isConnecting = false;
      this.consecutiveFailures = 0;
      this.currentReconnectInterval = this.baseReconnectInterval;
      this.emit('connected');

      // Start listening to station observations using the actual device ID
      const startMessage = {
        type: 'listen_start',
        device_id: deviceId,
        id: Date.now().toString(),
      };

      // Send listen_start message to begin receiving observations

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(startMessage));
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());

        if (message.type === 'obs_st' && message.obs) {

          const observation: WebSocketObservation = {
            type: 'obs_st',
            device_id: message.device_id!,
            obs: message.obs!,
          };

          const observations = new Observations(observation);
          this.emit('observation', observations);
        } else if (message.type === 'obs_sky' && message.obs) {
          // Handle Sky sensor observations (older Tempest format)

          const observation: WebSocketObservation = {
            type: 'obs_st',
            device_id: message.device_id!,
            obs: message.obs!,
          };

          const observations = new Observations(observation);
          this.emit('observation', observations);
        }
      } catch (error) {
        this.emit('error', error);
      }
    });

    this.ws.on('error', (error) => {
      this.isConnecting = false;
      this.consecutiveFailures++;

      // Check if this is a rate limiting error (429)
      const isRateLimited = !!(error.message && error.message.includes('429'));

      this.emit('error', error);
      this.scheduleReconnect(stationId, isRateLimited);
    });

    this.ws.on('close', () => {
      this.isConnecting = false;
      this.consecutiveFailures++;
      this.emit('disconnected');
      this.scheduleReconnect(stationId, false);
    });
  }

  private scheduleReconnect(stationId: string, isRateLimited: boolean): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Check if we've exceeded max retries
    if (this.consecutiveFailures >= this.maxRetries) {
      this.emit('error', new Error(`Max reconnection attempts (${this.maxRetries}) exceeded. Stopping reconnection attempts.`));
      return;
    }

    // Apply exponential backoff, with extra delay for rate limiting
    if (isRateLimited) {
      // For rate limiting, use a longer base interval
      this.currentReconnectInterval = Math.min(
        Math.max(30000, this.currentReconnectInterval * 2), // Start at 30s minimum for rate limits
        this.maxReconnectInterval
      );
    } else {
      // For other errors, use normal exponential backoff
      this.currentReconnectInterval = Math.min(
        this.baseReconnectInterval * Math.pow(2, this.consecutiveFailures - 1),
        this.maxReconnectInterval
      );
    }

    this.reconnectTimer = setTimeout(async () => {
      await this.connectWebSocket(stationId);
    }, this.currentReconnectInterval);

    // Emit reconnection info for logging
    this.emit('reconnectScheduled', {
      interval: this.currentReconnectInterval,
      failures: this.consecutiveFailures,
      isRateLimited,
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async reconnectIfNeeded(stationId: string): Promise<boolean> {
    if (this.isConnected()) {
      return true;
    }

    if (this.isConnecting) {
      return false;
    }

    try {
      await this.connectWebSocket(stationId);
      return true;
    } catch (error) {
      return false;
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private async makeRequest(url: string): Promise<TempestObservationData> {
    const { data } = await axios.get<TempestObservationData>(url, {
      params: {
        token: this.token,
      },
    });
    return data;
  }
}