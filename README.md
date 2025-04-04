# ELRS Buddy
Configure ExpressLRS modules from a web browser. This webapp simulates an EdgeTX Lua environment, speaks Crossfire via a serial port, and executes elrsV3.lua all in a browser.

## Free instance
Enjoy a free instance of this app at https://fourflies.mooo.com/elrsbuddy/

## Build instructions
If you do not have a Node.js environment already, you can start one quickly with Docker.  Download this 
repository and place it at ~/elrsbuddy before running this Docker command.
```bash
docker run -v ~/elrsbuddy:/eb -w /eb --name eb -ti --rm -p 8080:8080 node /bin/bash
```

### First install dependencies
```bash
npm install
```

### Start a development instance
```bash
npm start
```
Now you can connect to http://localhost:8080 to use elrsbuddy. Any changes will be automatically built and available.

### Build deployable artifacts
```bash
npm run build
```
After this completes, the deployable version will be placed in the `dist` folder.
