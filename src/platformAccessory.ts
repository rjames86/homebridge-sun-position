import type { PlatformAccessory, Service, Characteristic } from 'homebridge';
import * as suncalc from 'suncalc';

import type { SunPositionPlatform } from './platform';
import { Tempest, Observations } from './tempest';

// Custom characteristic UUIDs
const ALTITUDE_UUID = 'a8af30e7-5c8e-43bf-bb21-3c1343229260';
const AZIMUTH_UUID = 'ace1dd10-2e46-4100-a74a-cc77f13f1bab';

// Human-readable sun position UUIDs
const SUN_FACING_SOUTH_UUID = 'b1234567-1111-2222-3333-444444444444';
const SUN_FACING_EAST_UUID = 'b1234567-2222-3333-4444-555555555555';
const SUN_FACING_WEST_UUID = 'b1234567-3333-4444-5555-666666666666';
const SUN_HIGH_ELEVATION_UUID = 'b1234567-4444-5555-6666-777777777777';
const SUN_BELOW_HORIZON_UUID = 'b1234567-5555-6666-7777-888888888888';


export interface SunPositionDevice {
  uniqueId: string;
  displayName: string;
  location: {
    lat: number;
    long: number;
  };
  tempestKey?: string;
  tempestStationID?: string;
  updatePeriod: number;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SunPositionAccessory {
  private service: Service;
  private temperatureService?: Service;
  private humidityService?: Service;
  private airPressureService?: Service;
  private uvIndexService?: Service;
  private solarRadiationService?: Service;
  private windService?: Service;
  private rainService?: Service;
  private lightningService?: Service;
  private batteryService?: Service;
  private tempest?: Tempest;
  private updateTimer?: NodeJS.Timeout;
  private weatherFallbackTimer?: NodeJS.Timeout;
  private lastWebSocketUpdate: number = 0;
  private altitudeCharacteristic?: Characteristic;
  private azimuthCharacteristic?: Characteristic;

  // Human-readable characteristics
  private sunFacingSouthCharacteristic?: Characteristic;
  private sunFacingEastCharacteristic?: Characteristic;
  private sunFacingWestCharacteristic?: Characteristic;
  private sunHighElevationCharacteristic?: Characteristic;
  private sunBelowHorizonCharacteristic?: Characteristic;

  constructor(
    private readonly platform: SunPositionPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = this.accessory.context.device as SunPositionDevice;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'github.com rjames86')
      .setCharacteristic(this.platform.Characteristic.Model, 'Tempest Weather Station')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.uniqueId);

    // Create LightSensor service for Tempest weather data
    this.service = this.accessory.getService(this.platform.Service.LightSensor) ||
      this.accessory.addService(this.platform.Service.LightSensor, 'Illuminance', 'main');

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Illuminance');

    // Initialize with default lux value to prevent undefined warnings
    this.service.setCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, 0.0001);

    // Create weather sensor services if Tempest is configured
    if (device.tempestKey && device.tempestStationID) {
      this.setupWeatherServices();
    }

    // Create custom characteristics for altitude and azimuth
    this.createCustomCharacteristics();

    // Initialize Tempest if configured
    if (device.tempestKey && device.tempestStationID) {
      this.tempest = new Tempest(device.tempestKey);
      this.setupTempestWebSocket(device.tempestStationID);
      this.startWeatherDataFallback(device.tempestStationID);
    }

    // Start position updates
    this.updatePosition();
  }

  private setupWeatherServices() {
    // Helper function to create/get a service with initial characteristics
    const createService = (serviceType: any, name: string, subtype?: string) => {
      const service = this.accessory.getService(name) ||
        this.accessory.addService(serviceType, name, subtype);
      service.setCharacteristic(this.platform.Characteristic.Name, name);
      return service;
    };

    // Temperature sensor
    this.temperatureService = createService(this.platform.Service.TemperatureSensor, 'Air Temperature', 'temperature');
    this.temperatureService.setCharacteristic(this.platform.Characteristic.CurrentTemperature, 20);

    // Humidity sensor
    this.humidityService = createService(this.platform.Service.HumiditySensor, 'Humidity', 'humidity');
    this.humidityService.setCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, 50);

    // UV Index sensor (using LightSensor)
    // this.uvIndexService = createService(this.platform.Service.LightSensor, 'UV Index', 'uvindex');
    // this.uvIndexService.setCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, 0.0001);

    // Solar Radiation sensor (using LightSensor)
    // this.solarRadiationService = createService(this.platform.Service.LightSensor, 'Solar Radiation', 'solar');
    // this.solarRadiationService.setCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, 0.0001);

    // Rain sensor (using LeakSensor)
    // this.rainService = createService(this.platform.Service.LeakSensor, 'Rain Sensor', 'rain');
    // this.rainService.setCharacteristic(this.platform.Characteristic.LeakDetected, false);

    // Lightning sensor (using ContactSensor as base)
    // this.lightningService = createService(this.platform.Service.ContactSensor, 'Lightning Detector', 'lightning');
    // this.lightningService.setCharacteristic(this.platform.Characteristic.ContactSensorState, false);

    // Battery service
    this.batteryService = createService(this.platform.Service.Battery, 'Station Battery', 'battery');
    this.batteryService.setCharacteristic(this.platform.Characteristic.BatteryLevel, 100);
    this.batteryService.setCharacteristic(this.platform.Characteristic.StatusLowBattery, false);

  }

  private createCustomCharacteristics() {
    const { Characteristic, Formats, Units, Perms } = this.platform.api.hap;

    // Create Altitude characteristic class
    class AltitudeCharacteristic extends Characteristic {
      static readonly UUID = ALTITUDE_UUID;

      constructor() {
        super('Altitude', AltitudeCharacteristic.UUID, {
          format: Formats.FLOAT,
          unit: Units.ARC_DEGREE,
          minValue: -90,
          maxValue: 90,
          minStep: 0.1,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    // Create Azimuth characteristic class
    class AzimuthCharacteristic extends Characteristic {
      static readonly UUID = AZIMUTH_UUID;

      constructor() {
        super('Azimuth', AzimuthCharacteristic.UUID, {
          format: Formats.FLOAT,
          unit: Units.ARC_DEGREE,
          minValue: 0,
          maxValue: 360,
          minStep: 0.1,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    // Create human-readable boolean characteristics
    class SunFacingSouthCharacteristic extends Characteristic {
      static readonly UUID = SUN_FACING_SOUTH_UUID;
      constructor() {
        super('Sun Facing South', SunFacingSouthCharacteristic.UUID, {
          format: Formats.BOOL,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    class SunFacingEastCharacteristic extends Characteristic {
      static readonly UUID = SUN_FACING_EAST_UUID;
      constructor() {
        super('Sun Facing East', SunFacingEastCharacteristic.UUID, {
          format: Formats.BOOL,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    class SunFacingWestCharacteristic extends Characteristic {
      static readonly UUID = SUN_FACING_WEST_UUID;
      constructor() {
        super('Sun Facing West', SunFacingWestCharacteristic.UUID, {
          format: Formats.BOOL,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    class SunHighElevationCharacteristic extends Characteristic {
      static readonly UUID = SUN_HIGH_ELEVATION_UUID;
      constructor() {
        super('Sun High Elevation', SunHighElevationCharacteristic.UUID, {
          format: Formats.BOOL,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    class SunBelowHorizonCharacteristic extends Characteristic {
      static readonly UUID = SUN_BELOW_HORIZON_UUID;
      constructor() {
        super('Sun Below Horizon', SunBelowHorizonCharacteristic.UUID, {
          format: Formats.BOOL,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    }

    // Add characteristics to service
    this.altitudeCharacteristic = this.service.getCharacteristic(AltitudeCharacteristic) ||
      this.service.addCharacteristic(AltitudeCharacteristic);
    
    this.azimuthCharacteristic = this.service.getCharacteristic(AzimuthCharacteristic) ||
      this.service.addCharacteristic(AzimuthCharacteristic);

    // Add human-readable characteristics
    this.sunFacingSouthCharacteristic = this.service.getCharacteristic(SunFacingSouthCharacteristic) ||
      this.service.addCharacteristic(SunFacingSouthCharacteristic);
    
    this.sunFacingEastCharacteristic = this.service.getCharacteristic(SunFacingEastCharacteristic) ||
      this.service.addCharacteristic(SunFacingEastCharacteristic);
    
    this.sunFacingWestCharacteristic = this.service.getCharacteristic(SunFacingWestCharacteristic) ||
      this.service.addCharacteristic(SunFacingWestCharacteristic);
    
    this.sunHighElevationCharacteristic = this.service.getCharacteristic(SunHighElevationCharacteristic) ||
      this.service.addCharacteristic(SunHighElevationCharacteristic);
    
    this.sunBelowHorizonCharacteristic = this.service.getCharacteristic(SunBelowHorizonCharacteristic) ||
      this.service.addCharacteristic(SunBelowHorizonCharacteristic);

    // TODO: Add custom weather characteristics later
    // this.createWeatherCharacteristics(Characteristic, Formats, Units, Perms);

    this.platform.log.debug('Custom characteristics created successfully');
  }


  // TODO: Custom characteristics for weather data - implement later
  // private createWeatherCharacteristics() {
  //   // Custom characteristics will be added here in future updates
  // }

  private setupTempestWebSocket(stationId: string) {
    if (!this.tempest) {
      return;
    }

    // Handle real-time weather observations from WebSocket
    this.tempest.on('observation', (observations) => {
      this.updateWeatherData(observations, 'websocket');
    });

    // Handle connection events
    this.tempest.on('connected', () => {
      this.platform.log.info('Connected to Tempest WebSocket');

      // Get initial data via HTTP API for immediate display
      this.getInitialWeatherData(stationId);
    });

    this.tempest.on('disconnected', () => {
      this.platform.log.warn('Disconnected from Tempest WebSocket, will attempt to reconnect');
    });

    this.tempest.on('error', (error) => {
      this.platform.log.error('Tempest WebSocket error:', error instanceof Error ? error.message : 'Unknown error');
    });

    // Start WebSocket connection (async)
    this.tempest.connectWebSocket(stationId, this.platform.log).catch((error) => {
      this.platform.log.error('Failed to connect to WebSocket:', error instanceof Error ? error.message : 'Unknown error');
    });
  }

  private async getInitialWeatherData(stationId: string) {
    if (!this.tempest) {
      return;
    }

    try {
      this.platform.log.info('Fetching initial weather data via HTTP API...');
      const tempestData = await this.tempest.getStationObservation(stationId);
      this.updateWeatherData(tempestData, 'api');
      this.platform.log.info('Initial weather data loaded, now listening for real-time updates');
    } catch (err) {
      this.platform.log.warn('Failed to fetch initial Tempest data:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private updateWeatherData(tempestData: Observations, source: 'websocket' | 'api' = 'websocket') {
    try {
      let lux = tempestData.lux;
      if (lux === 0) {
        lux = 0.0001;
      }
      if (lux > 100000) {
        lux = 100000;
      }

      if (source === 'websocket') {
        this.lastWebSocketUpdate = Date.now();
      }

      this.platform.log.info(`Weather update (${source}) - T: ${tempestData.airTemperature}°C, H: ${tempestData.humidity}%, ` +
        `P: ${tempestData.pressure}MB, UV: ${tempestData.uvIndex}, Wind: ${tempestData.windSpeed}m/s @ ${tempestData.windDirection}°, ` +
        `Battery: ${tempestData.batteryLevel}% (${tempestData.batteryVoltage}V)`);

      // Update main light sensor
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, lux);

      // Update temperature service
      if (this.temperatureService) {
        this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, tempestData.airTemperature);
      }

      // Update humidity service
      if (this.humidityService) {
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, tempestData.humidity);
      }

      // Update rain service (using standard HomeKit LeakSensor)
      if (this.rainService) {
        this.rainService.updateCharacteristic(this.platform.Characteristic.LeakDetected, tempestData.isRaining);
      }

      // Update lightning service (using standard HomeKit ContactSensor)
      if (this.lightningService) {
        this.lightningService.updateCharacteristic(this.platform.Characteristic.ContactSensorState, tempestData.isLightningDetected);
      }

      // Update UV Index as light sensor
      if (this.uvIndexService) {
        // Map UV index (0-15) to lux-like values for display
        const uvAsLux = tempestData.uvIndex * 1000; // Scale UV index for visibility
        this.uvIndexService.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, Math.max(0.0001, uvAsLux));
      }

      // Update solar radiation as light sensor
      if (this.solarRadiationService) {
        // Use solar radiation directly as lux (W/m² is similar scale)
        const solarAsLux = Math.max(0.0001, tempestData.solarRadiation);
        this.solarRadiationService.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, solarAsLux);
      }

      // Update battery service
      if (this.batteryService) {
        this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, tempestData.batteryLevel);
        this.batteryService.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, tempestData.isLowBattery);

      }

    } catch (err) {
      this.platform.log.error('Failed to update weather data:', err instanceof Error ? err.message : 'Unknown error');
    }
  }

  private startWeatherDataFallback(stationId: string) {
    const device = this.accessory.context.device as SunPositionDevice;

    this.platform.log.info(`Starting weather data fallback checks every 10 minutes for WebSocket reliability`);

    // Check WebSocket connection and fallback to API if needed
    const fallbackCheck = async () => {
      if (!this.tempest) {
        return;
      }

      const now = Date.now();
      const timeSinceLastWebSocketUpdate = now - this.lastWebSocketUpdate;

      // If no WebSocket update in last 5 minutes, or WebSocket disconnected, use HTTP API
      const shouldUseAPI = !this.tempest.isConnected() || timeSinceLastWebSocketUpdate > 5 * 60 * 1000;

      if (shouldUseAPI) {
        if (!this.tempest.isConnected()) {
          this.platform.log.warn('WebSocket not connected, using HTTP API');
        } else {
          this.platform.log.info('No WebSocket updates recently, using HTTP API');
        }

        // Try to reconnect WebSocket if disconnected (but don't be aggressive)
        if (!this.tempest.isConnected()) {
          this.platform.log.info('WebSocket disconnected, attempting reconnection');
          await this.tempest.reconnectIfNeeded(stationId, this.platform.log);
        }

        // Use HTTP API for current data
        try {
          const tempestData = await this.tempest.getStationObservation(stationId);
          this.updateWeatherData(tempestData, 'api');
        } catch (err) {
          this.platform.log.error('HTTP API request failed:', err instanceof Error ? err.message : 'Unknown error');
        }
      }
    };

    // Run the fallback check every 10 minutes for WebSocket monitoring
    this.weatherFallbackTimer = setInterval(fallbackCheck, 10 * 60 * 1000);
    // Also run it once immediately after a short delay to check initial state
    setTimeout(fallbackCheck, 10000);
  }

  private async updatePosition() {
    const device = this.accessory.context.device as SunPositionDevice;
    const now = new Date();

    try {
      // Calculate sun position
      const position = suncalc.getPosition(now, device.location.lat, device.location.long);
      const altitude = (position.altitude * 180) / Math.PI;
      const azimuth = ((position.azimuth * 180) / Math.PI + 180) % 360;

      this.platform.log.info(`Sun is ${altitude.toFixed(1)}° high at ${azimuth.toFixed(1)}°`);

      // Update custom characteristics
      if (this.altitudeCharacteristic) {
        this.altitudeCharacteristic.updateValue(altitude);
      }
      if (this.azimuthCharacteristic) {
        this.azimuthCharacteristic.updateValue(azimuth);
      }

      // Calculate human-readable sun position values
      const sunFacingSouth = azimuth >= 135 && azimuth <= 225;  // South-facing (135° to 225°)
      const sunFacingEast = azimuth >= 45 && azimuth <= 135;    // East-facing (45° to 135°)
      const sunFacingWest = azimuth >= 225 && azimuth <= 315;   // West-facing (225° to 315°)
      const sunHighElevation = altitude > 45;                   // High elevation (above 45°)
      const sunBelowHorizon = altitude < 0;                     // Below horizon

      // Update human-readable characteristics
      if (this.sunFacingSouthCharacteristic) {
        this.sunFacingSouthCharacteristic.updateValue(sunFacingSouth);
      }
      if (this.sunFacingEastCharacteristic) {
        this.sunFacingEastCharacteristic.updateValue(sunFacingEast);
      }
      if (this.sunFacingWestCharacteristic) {
        this.sunFacingWestCharacteristic.updateValue(sunFacingWest);
      }
      if (this.sunHighElevationCharacteristic) {
        this.sunHighElevationCharacteristic.updateValue(sunHighElevation);
      }
      if (this.sunBelowHorizonCharacteristic) {
        this.sunBelowHorizonCharacteristic.updateValue(sunBelowHorizon);
      }

      this.platform.log.info(
        `Sun position: South=${sunFacingSouth}, East=${sunFacingEast}, West=${sunFacingWest}, ` +
        `High=${sunHighElevation}, BelowHorizon=${sunBelowHorizon}`,
      );

      // Weather data is now handled by WebSocket real-time updates in setupTempestWebSocket
      // No need to poll for weather data here anymore
    } catch (err) {
      this.platform.log.error('Failed to update sun position:', err instanceof Error ? err.message : 'Unknown error');
    }

    // Schedule next update
    this.updateTimer = setTimeout(() => {
      this.updatePosition();
    }, device.updatePeriod * 60 * 1000);
  }

  public destroy() {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    if (this.weatherFallbackTimer) {
      clearInterval(this.weatherFallbackTimer);
    }

    // Disconnect WebSocket
    if (this.tempest) {
      this.tempest.disconnect();
    }
  }
}