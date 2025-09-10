import type { PlatformAccessory, Service, Characteristic } from 'homebridge';
import * as suncalc from 'suncalc';

import type { SunPositionPlatform } from './platform';
import { Tempest } from './tempest';

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
  private tempest?: Tempest;
  private updateTimer?: NodeJS.Timeout;
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
      this.accessory.addService(this.platform.Service.LightSensor, 'Tempest');

    // Set the service name
    this.service.setCharacteristic(this.platform.Characteristic.Name, device.displayName);

    // Initialize with default lux value to prevent undefined warnings
    this.service.setCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, 0.0001);

    // Create TemperatureSensor service for temperature data if Tempest is configured
    if (device.tempestKey && device.tempestStationID) {
      this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor) ||
        this.accessory.addService(this.platform.Service.TemperatureSensor, 'Air Temperature');
      this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, 'Air Temperature');
      // Initialize with default temperature
      this.temperatureService.setCharacteristic(this.platform.Characteristic.CurrentTemperature, 20);
    }

    // Create custom characteristics for altitude and azimuth
    this.createCustomCharacteristics();

    // Initialize Tempest if configured
    if (device.tempestKey && device.tempestStationID) {
      this.tempest = new Tempest(device.tempestKey);
    }

    // Start position updates
    this.updatePosition();
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

    this.platform.log.debug('Custom characteristics created successfully');
  }

  private async updatePosition() {
    const device = this.accessory.context.device as SunPositionDevice;
    const now = new Date();

    try {
      // Calculate sun position
      const position = suncalc.getPosition(now, device.location.lat, device.location.long);
      const altitude = (position.altitude * 180) / Math.PI;
      const azimuth = ((position.azimuth * 180) / Math.PI + 180) % 360;

      this.platform.log.debug(`Sun is ${altitude.toFixed(1)}° high at ${azimuth.toFixed(1)}°`);

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

      this.platform.log.debug(`Sun position: South=${sunFacingSouth}, East=${sunFacingEast}, West=${sunFacingWest}, High=${sunHighElevation}, BelowHorizon=${sunBelowHorizon}`);

      // Get Tempest data if available
      if (this.tempest && device.tempestStationID) {
        try {
          const tempestData = await this.tempest.getStationObservation(device.tempestStationID);

          let lux = tempestData.lux;
          if (lux === 0) {
            lux = 0.0001;
          }
          if (lux > 100000) {
            lux = 100000;
          }

          this.platform.log.debug(`Setting lux value: ${lux}. Temperature is ${tempestData.airTemperature}°C`);
          
          this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, lux);
          
          // Update temperature on the separate TemperatureSensor service
          if (this.temperatureService) {
            this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, tempestData.airTemperature);
          }
        } catch (err) {
          this.platform.log.warn('Failed to fetch Tempest data:', err instanceof Error ? err.message : 'Unknown error');
        }
      }
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
  }
}