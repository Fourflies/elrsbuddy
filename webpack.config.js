const path = require('path')
const CopyWebpackPlugin = require('copy-webpack-plugin');
 
module.exports = {
	mode: 'production',
	resolve: {
		fallback: {
			path: false,
			fs: false,
			child_process: false,
			crypto: false,
			url: false,
			module: false
		},
	},
	entry: {
		'build': './src/index.js'
	},
	output: {
		filename: 'wasmoon-web.js',
		path: path.resolve(__dirname, 'dist'),
		library: {
			name: 'wasmoon',
			type: 'var'
		}
	},
	plugins: [
		new CopyWebpackPlugin({
            patterns: [
				{ from: 'img/*' },
                'src/elrsV3.lua',
                'src/worker.js',
				'src/index.html'
            ]
        })
	]
}
