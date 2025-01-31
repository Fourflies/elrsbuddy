# ELRS Buddy
Configure ExpressLRS modules from a web browser. This webapp simulates an EdgeTX Lua environment, speaks Crossfire via a serial port, and executes elrsV3.lua all in a browser.

## Free instance
Enjoy a free instance of this app at https://fourflies.mooo.com/elrsbuddy/

## Build instructions
First install dependencies
```bash
npm install
```

To do development testing
```bash
npm start
```
Now you can connect to http://localhost:8080 to use elrsbuddy. Any changes will be automatically built and available.

To build deployable artifacts
```bash
npm run build
```
After this completes, the deployable version will be placed in the `dist` folder.