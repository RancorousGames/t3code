// Set by the runtime stub that compile_t3.py installs next to the renamed Electron
// binary. That binary reports app.isPackaged = true, but it runs this checkout and
// must not share a profile, single-instance lock or branding with the installed app.
export const isSourceCheckoutRun = (): boolean => process.env.T3CODE_SOURCE_CHECKOUT === "1";
