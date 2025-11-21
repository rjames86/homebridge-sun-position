import axios from 'axios';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Logger, Logging } from 'homebridge';

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

interface WebSocketMessage {
  type: string;
  device_id?: number;
  serial_number?: string;
  hub_sn?: string;
  obs?: number[][];
  evt?: number[];
  id?: string;
}

interface WebSocketObservation {
  type: 'obs_st';
  device_id: number;
  obs: number[][];
}

// Listen start/stop message types
interface ListenStartMessage {
  type: 'listen_start';
  device_id: number;
  id: string;
}

interface ListenStopMessage {
  type: 'listen_stop';
  device_id: number;
  id: string;
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
  private isConnecting = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectInterval = 30000; // 30 seconds initial interval
  private maxReconnectInterval = 300000; // 5 minutes max
  private consecutiveFailures = 0;
  private maxRetries = 10;
  private deviceId?: number;

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

  async connectWebSocket(stationId: string, logger: Logging): Promise<void> {
    if (this.isConnecting || this.isConnected()) {
      logger.debug('WebSocket connection already in progress or connected');
      return;
    }

    // Get device ID first if we don't have it
    if (!this.deviceId) {
      const deviceId = await this.getTempestDeviceId(stationId);
      if (!deviceId) {
        throw new Error('Could not get device ID for station');
      }
      this.deviceId = deviceId;
    }

    this.isConnecting = true;

    // Use API key authentication (more stable than token)
    const wsUrl = `${WEBSOCKET_URL}?token=${this.token}`;
    logger.info(`Connecting to Tempest WebSocket for device ${this.deviceId}...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.isConnecting = false;
      this.consecutiveFailures = 0;
      this.reconnectInterval = 30000; // Reset interval
      logger.info('Connected to Tempest WebSocket');
      this.emit('connected');

      // Start listening for observations from our specific device
      this.startListening();
    });

    this.ws.on('message', (data) => {
      this.handleWebSocketMessage(data, logger);
    });

    this.ws.on('error', (error) => {
      this.isConnecting = false;
      logger.error(`WebSocket error: ${error.message}`);

      // Send stop listening message if we were connected
      this.sendStopListening();

      this.emit('error', error);
      this.scheduleReconnect(stationId, logger);
    });

    this.ws.on('close', (code, reason) => {
      this.isConnecting = false;
      logger.warn(`WebSocket closed (code: ${code}, reason: ${reason || 'none'})`);

      // Send stop listening message if we were connected
      this.sendStopListening();

      this.emit('disconnected');
      this.scheduleReconnect(stationId, logger);
    });
  }

  private startListening(): void {
    if (!this.ws || !this.deviceId) return;

    const listenMessage: ListenStartMessage = {
      type: 'listen_start',
      device_id: this.deviceId,
      id: Date.now().toString(),
    };

    this.ws.send(JSON.stringify(listenMessage));
  }

  private sendStopListening(): void {
    if (!this.ws || !this.deviceId || this.ws.readyState !== WebSocket.OPEN) return;

    const stopMessage: ListenStopMessage = {
      type: 'listen_stop',
      device_id: this.deviceId,
      id: Date.now().toString(),
    };

    try {
      this.ws.send(JSON.stringify(stopMessage));
    } catch (error) {
      // Ignore errors when sending stop message during disconnection
    }
  }

  private handleWebSocketMessage(data: WebSocket.Data, logger: Logging): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      // Handle observation messages
      if (message.type === 'obs_st' && message.obs && message.device_id === this.deviceId && message.device_id !== undefined) {
        const observation: WebSocketObservation = {
          type: 'obs_st',
          device_id: message.device_id,
          obs: message.obs,
        };

        const observations = new Observations(observation);
        this.emit('observation', observations);
      }
      // Handle acknowledgments and other message types silently
      else if (message.type === 'ack') {
        logger.debug(`WebSocket ACK received for message ID: ${message.id || 'unknown'}`);
      }
    } catch (error) {
      logger.error(`Failed to parse WebSocket message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(stationId: string, logger: Logging): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.consecutiveFailures++;

    // Stop trying after max retries
    if (this.consecutiveFailures >= this.maxRetries) {
      logger.error(`Max reconnection attempts (${this.maxRetries}) reached. Stopping reconnection attempts.`);
      return;
    }

    // Exponential backoff with jitter to avoid thundering herd
    const baseDelay = Math.min(this.reconnectInterval * Math.pow(1.5, this.consecutiveFailures), this.maxReconnectInterval);
    const jitter = Math.random() * 0.3 * baseDelay; // 30% jitter
    const delay = baseDelay + jitter;

    logger.info(`Scheduling WebSocket reconnection in ${Math.round(delay / 1000)} seconds (attempt ${this.consecutiveFailures + 1}/${this.maxRetries})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectWebSocket(stationId, logger);
      } catch (error) {
        logger.error(`Reconnection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }, delay);
  }

  async reconnectIfNeeded(stationId: string, logger: Logging): Promise<boolean> {
    if (this.isConnected()) {
      return true;
    }

    if (this.isConnecting) {
      logger.debug('WebSocket connection already in progress');
      return false;
    }

    try {
      await this.connectWebSocket(stationId, logger);
      return true;
    } catch (error) {
      logger.error(`Manual reconnection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      // Send stop listening message if connected
      this.sendStopListening();

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