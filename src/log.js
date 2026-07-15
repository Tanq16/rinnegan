const ts = () => new Date().toISOString();

export const info = (msg) => console.log(`${ts()} INFO ${msg}`);
export const error = (msg) => console.error(`${ts()} ERROR ${msg}`);
export const debug = (msg) => {
  if (process.env.DEBUG) console.debug(`${ts()} DEBUG ${msg}`);
};
