const { wateringDuration } = require('../src/services/fuzzy.service');

describe('wateringDuration', () => {
  test('returns no watering when soil moisture meets the target', () => {
    expect(wateringDuration({ soilMoisture: 65 }, 65)).toBe(0);
    expect(wateringDuration({ soilMoisture: 70 }, 65)).toBe(0);
  });

  test('scales watering duration with a capped soil-moisture deficit', () => {
    expect(wateringDuration({ soilMoisture: 60 }, 65)).toBe(10);
    expect(wateringDuration({ soilMoisture: 0 }, 65)).toBe(120);
  });

  test('does not water when soil moisture is unavailable', () => {
    expect(wateringDuration({ soilMoisture: null }, 65)).toBe(0);
  });
});
