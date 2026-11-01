function wateringDuration(reading, targetSoil) {
  if (!Number.isFinite(reading.soilMoisture) || reading.soilMoisture >= targetSoil) return 0;
  const deficit = Math.min(targetSoil - reading.soilMoisture, 60);
  return Math.max(1, Math.round(deficit * 2));
}

module.exports = { wateringDuration };
