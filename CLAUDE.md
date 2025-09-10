# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homebridge plugin that exposes the position of the sun for HomeKit automation. The plugin creates a light sensor accessory that provides sun altitude, azimuth, and lux values from a Tempest weather station.

## Key Dependencies

- `suncalc`: Calculates sun position based on geographic coordinates
- `axios`: HTTP client for API requests to Tempest weather station
- Homebridge platform (requires Homebridge >=0.2.0, Node.js >=0.12.0)

## Architecture

The codebase consists of two main modules:

### Core Plugin (`index.js`)
- **SunPositionAccessory**: Main accessory class that implements the Homebridge accessory interface
- **Custom Characteristics**: Defines `AltitudeCharacteristic` and `AzimuthCharacteristic` with custom UUIDs
- **Sun Position Calculation**: Uses `suncalc` library to calculate altitude/azimuth based on lat/long
- **Update Loop**: Refreshes position every 5 minutes (configurable via `updatePeriod`)
- **Service Integration**: Exposes data through HomeKit's LightSensor service

### Tempest Weather Integration (`tempest.js`)
- **Tempest class**: Handles API communication with WeatherFlow Tempest stations
- **Observations class**: Processes and formats weather data (lux values, air temperature)
- **API Integration**: Fetches real-time weather data to provide accurate lux readings

## Configuration

The plugin requires configuration in Homebridge's `config.json`:

```json
{
    "accessory": "RyanSunPosition",
    "name": "Sun",
    "location": {
        "lat": 37.2343,
        "long": -115.8067
    },
    "tempestKey": "your-tempest-api-key",
    "tempestStationID": "your-station-id",
    "updatePeriod": 5
}
```

## Key Implementation Details

- **Custom UUIDs**: Uses predefined UUIDs for altitude (`a8af30e7-5c8e-43bf-bb21-3c1343229260`) and azimuth (`ace1dd10-2e46-4100-a74a-cc77f13f1bab`) characteristics
- **Lux Handling**: Applies bounds checking (minimum 0.0001, maximum 100000) for lux values
- **Temperature Conversion**: Always returns Celsius (commented out Fahrenheit conversion logic)
- **Error Handling**: Gracefully handles Tempest API failures while continuing sun position updates
- **Async Operations**: Uses async/await pattern for weather data fetching

## Development Notes

- No build, test, or lint scripts are defined in package.json
- Plugin follows Homebridge accessory plugin conventions
- The plugin registers as "RyanSunPosition" accessory type
- Uses traditional callback patterns for Homebridge compatibility mixed with modern async/await for API calls