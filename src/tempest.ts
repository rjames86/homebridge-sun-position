import axios from 'axios';

const BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const STATION_OBSERVATION_URL = (stationId: string) => `${BASE_URL}/observations/station/${stationId}`;

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

export class Observations {
  private tempestData: TempestObservationData;
  private observation: TempestObservationData['obs'][0];

  constructor(tempestData: TempestObservationData) {
    this.tempestData = tempestData;
    this.observation = tempestData.obs[0];
  }

  get airTemperature(): number {
    // Tempest API always returns temperature in Celsius
    // The station_units.units_temp field indicates the user's display preference, 
    // not the API data format
    const temp = this.observation.air_temperature;
    
    return Math.round(temp * 100) / 100; // Round to 2 decimal places
  }

  get lux(): number {
    return this.observation.brightness;
  }
}

export class Tempest {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async getStationObservation(stationId: string): Promise<Observations> {
    const response = await this.makeRequest(STATION_OBSERVATION_URL(stationId));
    return new Observations(response);
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