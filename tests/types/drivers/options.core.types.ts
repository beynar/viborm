import { PGliteDriver, type PGliteDriverOptions } from "@src/drivers";

const options: PGliteDriverOptions = {};
const driver = new PGliteDriver(options);

const executeRaw: typeof driver._executeRaw = driver._executeRaw.bind(driver);

void executeRaw;
