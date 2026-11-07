-- CreateTable
CREATE TABLE "SensorData" (
    "id" SERIAL NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "soil_moisture" INTEGER,
    "temperature" DOUBLE PRECISION,
    "humidity" DOUBLE PRECISION,
    "battery_voltage" DOUBLE PRECISION,
    "battery_percent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensorData_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SensorData_nodeId_createdAt_idx" ON "SensorData"("nodeId", "createdAt");

-- AddForeignKey
ALTER TABLE "SensorData" ADD CONSTRAINT "SensorData_nodeId_fkey"
FOREIGN KEY ("nodeId") REFERENCES "Node"("nodeId") ON DELETE CASCADE ON UPDATE CASCADE;
