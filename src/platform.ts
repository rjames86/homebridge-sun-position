import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { SunPositionAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

// This is only required when using Custom Services and Characteristics not support by HomeKit
import { EveHomeKitTypes } from 'homebridge-lib/EveHomeKitTypes';

export interface SunPositionConfig extends PlatformConfig {
  location: {
    lat: number;
    long: number;
  };
  tempestKey?: string;
  tempestStationID?: string;
  updatePeriod?: number;
}

/**
 * SunPositionPlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SunPositionPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: SunPositionConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // This is only required when using Custom Services and Characteristics not support by HomeKit
    this.CustomServices = new EveHomeKitTypes(this.api).Services;
    this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Discover and register the sun position accessory.
   */
  discoverDevices() {
    // Validate configuration
    if (!this.config.location || 
        !Number.isFinite(this.config.location.lat) || 
        !Number.isFinite(this.config.location.long)) {
      this.log.error('Missing or invalid location configuration');
      return;
    }

    const sunDevice = {
      uniqueId: 'sun-position',
      displayName: this.config.name || 'Sun',
      location: this.config.location,
      tempestKey: this.config.tempestKey,
      tempestStationID: this.config.tempestStationID,
      updatePeriod: this.config.updatePeriod || 5,
    };

    // Generate UUID for the sun position accessory
    const uuid = this.api.hap.uuid.generate(sunDevice.uniqueId);

    // Check if accessory already exists
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      // the accessory already exists
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      // Update the context with current config
      existingAccessory.context.device = sunDevice;
      this.api.updatePlatformAccessories([existingAccessory]);

      // create the accessory handler for the restored accessory
      new SunPositionAccessory(this, existingAccessory);
    } else {
      // the accessory does not yet exist, so we need to create it
      this.log.info('Adding new accessory:', sunDevice.displayName);

      // create a new accessory
      const accessory = new this.api.platformAccessory(sunDevice.displayName, uuid);

      // store a copy of the device object in the `accessory.context`
      accessory.context.device = sunDevice;

      // create the accessory handler for the newly create accessory
      new SunPositionAccessory(this, accessory);

      // link the accessory to your platform
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // Track discovered UUID
    this.discoveredCacheUUIDs.push(uuid);

    // you can also deal with accessories from the cache which are no longer present by removing them from Homebridge
    // for example, if your plugin logs into a cloud account to retrieve a device list, and a user has previously removed a device
    // from this cloud account, then this device will no longer be present in the device list but will still be in the Homebridge cache
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
