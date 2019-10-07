const { config, persist, cinemeta } = require('internal')
const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const base64 = require('base-64')
const async = require('async')
const needle = require('needle')

const pref = 'plex:'

const namedQueue = require('named-queue')
const searchQueue = new namedQueue((task, cb) => {
	needle.get(task.id, { headers: task.server.headers }, (err, resp, body) => {
		try {
			body = JSON.parse(body)
		} catch(e) {}

		let items = []

		if ((((body || {})['MediaContainer'] || {})['Hub'] || []).length)
			items = body['MediaContainer']['Hub']

		cb(items)

	})
}, 5)

const crypto = require('crypto-js')

function makeGuid() {
	function randomString(length, chars) {
		var result = '';
		for (var i = length; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
		return result;
	}
	return randomString(24, '0123456789abcdefghijklmnopqrstuvwxyz')
}

function retrieveRouter() {

	return new Promise((resolver, rejecter) => {

		const headers = {
			'Accept': 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'Origin': 'https://app.plex.tv',
			'Referer': 'https://app.plex.tv/',
			'Sec-Fetch-Mode': 'cors',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.90 Safari/537.36'
		}

		const plexData = {
			'X-Plex-Product': 'Plex Web',
			'X-Plex-Version': '4.8.3',
			'X-Plex-Client-Identifier': 'lu1h80a0qe5hlj9qidv5t55o',
			'X-Plex-Platform': 'Chrome',
			'X-Plex-Platform-Version': '77.0',
			'X-Plex-Device': 'OSX',
			'X-Plex-Device-Screen-Resolution': '1122x759,1440x900'
		}

		function serialize(obj) {
			let str = []
			for (let p in obj)
				str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p] + ''))
			return str.join("&")
		}

		let accessData = {}

		let servers = []

		const mapFromImdb = {}

		if (config.user && config.pass) {
			needle.post('https://plex.tv/api/v2/users/signin?' + serialize(plexData), 'login=' + config.user + '&password=' + config.pass + '&rememberMe=true', { headers }, (err, resp, body) => {
				try {
					body = JSON.parse(body)
				} catch(e) {}

				if (body['authToken']) {
					accessData = body

					headers['X-Connect-UserToken'] = body['authToken']

					const serverData = {
						'includeHttps': 1,
						'includeRelay': 1,
						'X-Plex-Sync-Version': 2,
						'X-Plex-Features': 'external-media',
						'X-Plex-Model': 'hosted',
						'X-Plex-Device-Name': 'Chrome',
						'X-Plex-Token': accessData['authToken'],
						'X-Plex-Language': 'en-GB'
					}

					const resourceData = { ...plexData, ...serverData }

					const resourceHeaders = JSON.parse(JSON.stringify(headers))

					resourceHeaders['accept-language'] = 'en-GB'

					resourceHeaders['accept'] = 'application/xml'

					console.log('plex client: credentials correct, user logged in')

					needle.get('https://plex.tv/api/resources?' + serialize(resourceData), { headers: resourceHeaders }, (err, resp, body) => {

						try {
							body = JSON.parse(body)
						} catch(e) {}

						if (((body || {}).children || []).length) {

							console.log('plex client: ' + body.children.length + ' servers added from user ' + accessData['username'])

							const serverQueue = async.queue((serverData, callback) => {

								// connect to server and get all needed manifest data

								let serverUrl

								let serverIsLocal

								const srvs = []

								const serverHeaders = {
									'Accept': 'application/json',
									'Accept-Language': 'en-GB',
									'Origin': 'https://app.plex.tv',
									'Referer': 'https://app.plex.tv/',
									'Sec-Fetch-Mode': 'cors',
									'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.90 Safari/537.36',
								}

								const serverQuery = {
									...plexData,
									'X-Plex-Sync-Version': 2,
									'X-Plex-Features': 'external-media',
									'X-Plex-Model': 'hosted',
									'X-Plex-Device-Name': 'Chrome',
									'X-Plex-Token': (serverData.attributes || {}).accessToken,
									'X-Plex-Language': 'en-GB'
								}

								let serversLength = 0

								serverData.children.forEach(el => {
									const attributes = (el || {}).attributes || {}
									if (attributes.uri) {
										serversLength++
										srvs.push(function(cb) {
											needle.get(attributes.uri + '/media/providers?' + serialize(serverQuery), { headers: serverHeaders }, (err, resp, body) => {
												try {
													body = JSON.parse(body)
												} catch(e) {}

												if ((body || {})['MediaContainer']) {
													serverUrl = attributes.uri
													serverIsLocal = !!(attributes.local === '1')
													cb(null, body)
												} else {
													serversLength--
													if (!serversLength)
														cb(Error('could not connect to any server'))
												}
											})
										})
									}
								})

								async.race(srvs, (err, body) => {
									let serverName = (serverData.attributes || {}).name

									if (serverUrl)
										console.log('plex client: ' + serverName + ' -> remote url: ' + serverUrl)

									if (!serverUrl) {
										console.log('plex client: could not get remote url or local address for server ' + serverName + ', aborting connection attempt')
										callback()
										return
									}

									servers.push({
										url: serverUrl,
										key: (serverData.attributes || {}).accessToken,
										name: serverName,
										isLocal: serverIsLocal,
										headers: serverHeaders,
										query: serverQuery
									})

									const serverIdx = servers.length -1

									if (body['MediaContainer'].friendlyName)
										servers[serverIdx].name = body['MediaContainer'].friendlyName

									console.log('plex client: authenticated user ' + accessData['username'] + ' to server ' + servers[serverIdx].name)

									servers[serverIdx].catalogs = []
									if ((body['MediaContainer']['MediaProvider'] || []).length) {
										body['MediaContainer']['MediaProvider'].some(el => {
											if (el.title == 'Library' && (el['Feature'] || []).length) {
												el['Feature'].forEach(elm => {
													if (elm.type == 'content' && (elm['Directory'] || []).length) {
														elm['Directory'].forEach(elmr => {
															if (['movie', 'show'].includes(elmr.type)) {
																const key = encodeURIComponent(elmr.key)
																servers[serverIdx].catalogs.push({
																	name: elmr.title + ' - ' + servers[serverIdx].name,
																	id: servers[serverIdx].key + '|' + key,
																	type: elmr.type == 'movie' ? 'movie' : 'series',
																	extra: [{ name: 'skip' }, { name: 'search' }]
																})
															} else if (elmr.type == 'artist') {
																// this is for music
															}
														})
													} else if (elm.type == 'search' && elm.key) {
														servers[serverIdx].searchKey = elm.key
													}
												})
												return true
											}
										})
									}
									if (servers[serverIdx].catalogs.length) {

										console.log('plex client: loaded ' + servers[serverIdx].catalogs.length + ' library catalogs for ' + accessData['username'] + ' from server ' + servers[serverIdx].name)

										// now we need to get genres for EACH catalog

										servers[serverIdx].genreMaps = {}

										const genreQueue = async.queue((tsk, cb) => {
											const key = decodeURIComponent(tsk.id.split('|')[1])

											needle.get(servers[serverIdx].url + key + '/genre?' + serialize(servers[serverIdx].query), { headers: servers[serverIdx].headers }, (err, resp, body) => {
												try {
													body = JSON.parse(body)
												} catch(e) {}

												if ((((body || {})['MediaContainer'] || {})['Directory'] || []).length) {
													let catalogIdx = -1

													servers[serverIdx].catalogs.some((el, ij) => {
														if (el.id == tsk.id) {
															catalogIdx = ij
															return true
														}
													})

													if (catalogIdx > -1) {
														const channelId = tsk.id.split('|')[1]

														servers[serverIdx].genreMaps[channelId] = JSON.parse(JSON.stringify(body['MediaContainer']['Directory']))
														servers[serverIdx].catalogs[catalogIdx].genres = body['MediaContainer']['Directory'].filter(el => !!(el.type == 'genre')).map(el => { return el['title'] })
														servers[serverIdx].catalogs[catalogIdx].extra = [ { name: 'genre' }, { name: 'skip' }, { name: 'search' } ]
													}

												}

												cb()
											})
										}, 4)

										genreQueue.drain = () => {
											callback()
										}

										servers[serverIdx].catalogs.forEach(el => {
											genreQueue.push(el)
										})
										
									} else {
										console.log('plex client: could not find any content for ' + accessData['username'] + ' on server ' + servers[serverIdx].name)
										callback()
									}

								})
							}, 4)

							serverQueue.drain = () => {

								const manifest = {
									id: 'com.stremio.plexclient',
									name: 'Plex Client',
									description: 'Plex client to view your Plex media servers in Stremio.',
									version: '0.0.1',
									catalogs: [],
									background: '',
									logo: 'https://assets.pcmag.com/media/images/517012-plex-logo.png?width=333&height=245',
									resources: ['catalog', 'meta', 'stream'],
									types: ['movie', 'series'],
									idPrefixes: [pref, 'tt']
								}

								servers.forEach(server => {
									manifest.catalogs = manifest.catalogs.concat(server.catalogs)
								})

								manifest.catalogs = manifest.catalogs.filter(el => !!el)

								const builder = new addonBuilder(manifest)

								builder.defineCatalogHandler(args => {
									return new Promise((resolve, reject) => {

										const parts = args.id.split('|')
										const serverId = parts[0]
										const channelId = decodeURIComponent(parts[1])

										let server 

										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})

										if (!server) {
											reject('plex client: could not find server for request: ' + args.id + ' / with genre: ' + args.extra.genre)
											return
										}

										const type = args.type.charAt(0).toUpperCase() + args.type.slice(1)

										const methodUrl = channelId || serverId

										function getCatalog(url) {
											needle.get(url, { headers: server.headers }, (err, resp, body) => {
												try {
													body = JSON.parse(body)
												} catch(e) {}

												let items = []

												if ((((body || {})['MediaContainer'] || {})['Metadata'] || []).length)
													items = body['MediaContainer']['Metadata']
												else if ((((body || {})['MediaContainer'] || {})['Hub'] || []).length) {
													body['MediaContainer']['Hub'].forEach(el => {
														const typeCorrect = (el.type == args.type || (el.type == 'show' && args.type == 'series'))
														if (typeCorrect && ((el || {})['Metadata'] || []).length) {
															el['Metadata'].forEach(elm => {
																const elmTypeCorrect = (elm.type == args.type || (elm.type == 'show' && args.type == 'series'))
																if (elmTypeCorrect)
																	items.push(elm)
															})
														}
													})
												}

												if (items.length) {
													resolve({
														metas: items.map(el => {
															const meta = {
																type: args.type,
																name: el.title,
																id: pref + serverId + '|' + encodeURIComponent(el.key),
															}
															if (el.thumb) {
																const imageQuery = {
																	width: 280,
																	height: 420,
																	minSize: 1,
																	upscale: 1,
																	url: el.thumb + '?' + serialize({ 'X-Plex-Token': server.query['X-Plex-Token'] }),
																	'X-Plex-Token': server.query['X-Plex-Token']
																}
																meta.poster = server.url + '/photo/:/transcode?' + serialize(imageQuery)
															}

															return meta
														})
													})
												} else
													reject('plex client: could not get catalog items for request: ' + args.id + ' / with genre: ' + args.extra.genre)

											})
										}

										if (!args.extra.genre && !args.extra.search) {
											const defaultQuery = {
												...server.query,
												sort: 'originallyAvailableAt:desc',
												includeCollections: 1,
												includeAdvanced: 1,
												includeMeta: 1,
												'X-Plex-Container-Start': args.extra.skip || 0,
												'X-Plex-Container-Size': 50,
											}
											const url = server.url + channelId + '/all?' + serialize(defaultQuery)
											getCatalog(url)
										} else if (args.extra.genre) {
											let genreId
											const gmap = server.genreMaps[encodeURIComponent(channelId)] || []

											gmap.some(el => {
												if (el.title == args.extra.genre) {
													genreId = el.fastKey
													return true
												}
											})

											if (!genreId) {
												reject('plex client: could not get genre id for request: ' + args.id + ' / with genre: ' + args.extra.genre)
												return
											}

											const genreQuery = {
												...server.query,
												includeCollections: 1,
												includeAdvanced: 1,
												includeMeta: 1,
												'X-Plex-Container-Start': args.extra.skip || 0,
												'X-Plex-Container-Size': 50
											}
											const url = server.url + genreId + '&' + serialize(genreQuery)
											getCatalog(url)
										} else if (args.extra.search) {
											const searchQuery = {
												...server.query,
												query: args.extra.search,
												limit: 30,
												includeCollections: 1
											}
											const url = server.url + server.searchKey + '?' + serialize(searchQuery)

											searchQueue.push({
												id: url,
												server
											}, items => {

												const results = []

												if (items.length)
													items.forEach(el => {
														const typeCorrect = (el.type == args.type || (el.type == 'show' && args.type == 'series'))
														if (typeCorrect && ((el || {})['Metadata'] || []).length) {
															el['Metadata'].forEach(elm => {
																const elmTypeCorrect = (elm.type == args.type || (elm.type == 'show' && args.type == 'series'))
																if (elmTypeCorrect) {
																	if (elm.librarySectionKey) {
																		if (channelId == elm.librarySectionKey)
																			results.push(elm)
																	} else if (elm.hasOwnProperty('librarySectionID')) {
																		if (channelId.endsWith('/' + elm.librarySectionID))
																			results.push(elm)
																	} else if (elm.reason == 'section') {
																		if (channelId.endsWith('/' + elm.reasonID))
																			results.push(elm)
																	} else
																		results.push(elm)
																}
															})
														}
													})

												resolve({
													metas: results.map(el => {
														const meta = {
															type: args.type,
															name: el.title,
															id: pref + serverId + '|' + encodeURIComponent(el.key),
														}
														if (el.thumb) {
															const imageQuery = {
																width: 280,
																height: 420,
																minSize: 1,
																upscale: 1,
																url: el.thumb + '?' + serialize({ 'X-Plex-Token': server.query['X-Plex-Token'] }),
																'X-Plex-Token': server.query['X-Plex-Token']
															}
															meta.poster = server.url + '/photo/:/transcode?' + serialize(imageQuery)
														}

														return meta
													})
												})

											})
										} else {
											reject('plex client: unknown catalog request')
										}
									})
								})

								builder.defineMetaHandler(args => {
									return new Promise((resolve, reject) => {
										const parts = args.id.replace(pref, '').split('|')
										const serverId = parts[0]
										const itemId = decodeURIComponent(parts[1])

										let server 
										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})

										if (!server) {
											reject('plex client: could not find server for meta request: ' + args.id + ' / of type: ' + args.type)
											return
										}

										const metaQuery = {
											'Accept-Language': 'en-GB',
											includeConcerts: 1,
											includeExtras: 1,
											includeOnDeck: 1,
											includePopularLeaves: 1,
											includePreferences: 1,
											includeChapters: 1,
											includeStations: 1,
											includeExternalMedia: 1,
											asyncAugmentMetadata: 1,
											asyncCheckFiles: 1,
											asyncRefreshAnalysis: 1,
											asyncRefreshLocalMediaAgent: 1,
											...server.query
										}

										const url = server.url + itemId + '?' + serialize(metaQuery)

										needle.get(url, { headers: server.headers }, (err, resp, body) => {

											try {
												body = JSON.parse(body)
											} catch(e) {}

											if ((((body || {})['MediaContainer'] || {})['Metadata'] || [])[0]) {

												body = body['MediaContainer']['Metadata']

												let actors = []
												if ((body[0]['Role'] || []).length) {
													actors = body[0]['Role'].map(el => {
														return el.tag
													}).slice(0,5)
												}

												let poster
												if (body[0].thumb) {
													const imageQuery = {
														width: 400,
														height: 600,
														minSize: 1,
														upscale: 1,
														url: body[0].thumb + '?' + serialize({ 'X-Plex-Token': server.query['X-Plex-Token'] }),
														'X-Plex-Token': server.query['X-Plex-Token']
													}
													poster = server.url + '/photo/:/transcode?' + serialize(imageQuery)
												}

												let background
												if (body[0].art) {
													const imageQuery = {
														width: 640,
														height: 433,
														opacity: 30,
														background: '36383b',
														format: 'png',
														blur: 57,
														minSize: 1,
														upscale: 1,
														url: body[0].art + '?' + serialize({ 'X-Plex-Token': server.query['X-Plex-Token'] }),
														'X-Plex-Token': server.query['X-Plex-Token']
													}
													background = server.url + '/photo/:/transcode?' + serialize(imageQuery)
												}

												let genres = []
												if ((body[0]['Genre'] || []).length)
													genres = body[0]['Genre'].map(el => { return el.tag })

												const meta = {
													id: args.id,
													type: args.type,
													name: body[0].parentTitle || body[0].title,
													genres: genres,
													description: body[0].summary,
													cast: actors,
													releaseInfo: body[0].year || undefined,
													poster,
													background
												}

												if (args.type == 'movie')
													resolve({ meta })
												else {
													// get season / episodes from plex api

													let dummyTime = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).getTime()

													const days1 = 86400000

													let videos = []

													const seasonQ = async.queue((task, cb) => {
														if (task.type != 'season') {
															cb()
															return
														}
														const episodesQuery = {
															excludeAllLeaves: 1,
															'X-Plex-Container-Start': 0,
															'X-Plex-Container-Size': 20,
															...server.query
														}
														const szIdx = task.index
														needle.get(server.url + task.key + '/children?' + serialize(episodesQuery), { headers: server.headers }, (err, resp, body) => {
															if ((((body || {})['MediaContainer'] || {})['Metadata'] || []).length) {
																const results = []
																body['MediaContainer']['Metadata'].forEach(el => {
																	if (el.type == 'episode') {
																		dummyTime += days1
																		results.push({
																			id: pref + serverId + '|' + encodeURIComponent(el.key),
																			season: szIdx,
																			episode: el.index,
																			number: el.index,
																			name: el.title,
																			released: new Date(dummyTime).toISOString(),
																			firstAired: new Date(dummyTime).toISOString()
																		})
																	}
																})
																if ((results || []).length)
																	videos = videos.concat(results)
															}
															cb()
														})
													}, 1)

													seasonQ.drain = () => {
														meta.videos = videos
														resolve({ meta })
													}

													body.forEach(season => {
														seasonQ.push(season)
													})

												}

											} else {
												reject('plex client: could not get meta from server for request: ' + args.id + ' / of type: ' + args.type)
											}

										})

									})
								})

								builder.defineStreamHandler(args => {
									return new Promise((resolve, reject) => {
										const parts = args.id.replace(pref, '').split('|')
										const serverId = parts[0]
										let itemId = decodeURIComponent(parts[1])

										let server

										servers.some(el => {
											if (el.key == serverId) {
												server = el
												return true
											}
										})

										if (!server) {
											reject('plex client: could not find server for stream request: ' + args.id + ' / of type: ' + args.type)
											return
										}

										if (itemId.startsWith('tt') && parseInt(itemId.replace('tt','')) == itemId.replace('tt','')) {
											if (!mapFromImdb[itemId]) {
												reject('plex client: could not find imdb id for request: ' + args.id + ' / of type: ' + args.type)
												return
											} else {
												itemId = mapFromImdb[itemId]
											}
										}

										if (itemId) {
											const streamQuery = {
												'Accept-Language': 'en-GB',
												includeConcerts: 1,
												includeExtras: 1,
												includeOnDeck: 1,
												includePopularLeaves: 1,
												includePreferences: 1,
												includeChapters: 1,
												includeStations: 1,
												includeExternalMedia: 1,
												asyncAugmentMetadata: 1,
												asyncCheckFiles: 1,
												asyncRefreshAnalysis: 1,
												asyncRefreshLocalMediaAgent: 1,
												...server.query
											}
											const url = server.url + itemId + '?' + serialize(streamQuery)

											needle.get(url, { headers: server.headers }, (err, resp, body) => {

												try {
													body = JSON.parse(body)
												} catch(e) {}

												if ((((((((body || {})['MediaContainer'] || {})['Metadata'] || [])[0] || {})['Media'] || [])[0] || {})['Part'] || []).length) {

													const streams = []

													const qual = body['MediaContainer']['Metadata'][0]['Media'][0].height + 'p'

													const streamQueue = async.queue((task, cb) => {
														streams.push({
															title: 'Direct URL' + (qual ? ', ' + qual : ''),
															url: server.url + task.key + '?' + serialize(streamQuery)
														})

														const ssid = makeGuid()

														const transQuery = {
															hasMDE: 1,
															path: itemId,
															mediaIndex: 0,
															partIndex: 0,
															protocol: 'hls',
															fastSeek: 1,
															directPlay: 0,
															directStream: 1,
															subtitleSize: 100,
															audioBoost: 100,
															location: server.isLocal ? 'lan' : 'wan',
															maxVideoBitrate: 8000,
															addDebugOverlay: 0,
															autoAdjustQuality: 0,
															directStreamAudio: 1,
															mediaBufferSize: 102400,
															session: ssid,
															subtitles: 'burn',
															'Accept-Language': 'en-GB',
															'X-Plex-Session-Identifier': ssid,
															'X-Plex-Client-Profile-Extra': 'add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.bitrate&value=8000&replace=true)+append-transcode-target-codec(type=videoProfile&context=streaming&audioCodec=aac&protocol=dash)',
															...server.query
														}

														const streamHeaders = {
															'Origin': 'https://app.plex.tv',
															'Referer': 'https://app.plex.tv/',
															'Sec-Fetch-Mode': 'cors',
															'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.90 Safari/537.36',
														}

														needle.get(server.url + '/video/:/transcode/universal/start.mpd?' + serialize(transQuery), { headers: streamHeaders }, (err, resp, body) => {
															body = Buffer.isBuffer(body) ? body.toString() : body
//															console.log(body)
															if (!err && (body || '').includes('.m3u8')) {
																body.split(/\r?\n/).some(el => {
																	if (el.endsWith('.m3u8')) {
																		if (el.startsWith('http')) {
																			streams.push({
																				title: 'Web Stream, Chrome Browser',
																				url: el
																			})
																		} else if (el.startsWith('/')) {
																			streams.push({
																				title: 'Web Stream, Chrome Browser',
																				url: server.url + el
																			})
																		} else {
																			streams.push({
																				title: 'Web Stream, Chrome Browser',
																				url: server.url + '/video/:/transcode/universal/' + el
																			})
																		}
																		return true
																	}
																})
															}
															cb()
														})
													}, 1)

													streamQueue.drain = () => {
														if (streams.length)
															resolve({ streams })
														else
															reject('plex client: no streams for id: ' + args.id)
													}

													body['MediaContainer']['Metadata'][0]['Media'][0]['Part'].forEach(el => {
														streamQueue.push(el)
													})
												} else {
													reject('plex client: wrong streams api response for id: ' + args.id)
												}
											})
										} else {
											reject('plex client: cannot find stream for request ' + args.id)
										}

									})
								})

								//builder.defineSubtitlesHandler(args => {
								  // ...
								//})

								resolver(getRouter(builder.getInterface()))

							}

							body.children.forEach(el => {
								serverQueue.push(el)
							})

						} else {
							console.log('plex client: server list for user ' + accessData['username'] + ' is empty')
						}

					})

				} else {
					console.log('plex client: credentials incorrect, user could not be logged in')
				}

			})
		} else {
			console.log('plex client: user and password are mandatory')
		}
	})

}

module.exports = retrieveRouter()
