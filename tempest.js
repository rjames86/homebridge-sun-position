const axios = require('axios');

const BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const STATION_OBSERVATION_URL = (STATION_ID) => `${BASE_URL}/observations/station/${STATION_ID}`;


class Observations {
    constructor(tempestData) {
        this.tempestData = tempestData;
        this.observation = tempestData.obs[0];
    }

    get airTemperature() {
        if (this.tempestData.station_units.units_temp === "f") {
            const r = 1.8 * this.observation.air_temperature + 32;
            return Math.round(100 * r) / 100;
        }
        return this.observation.air_temperature;
    }

    get lux() {
        return this.observation.brightness;
    }
    
}

class Tempest {
    constructor(token) {
        this.token = token;
    }

    async getStationObservation(stationID) {
        const resp = await this.makeRequest(STATION_OBSERVATION_URL(stationID));
        return new Observations(resp);
    }

    async makeRequest(url) {
        const { data } = await axios.get(url, {
            params: {
                token: this.token
            }
        });
        return data;
        
    }
}

module.exports.Tempest = Tempest;