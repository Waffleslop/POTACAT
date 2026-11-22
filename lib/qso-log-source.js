'use strict';
// Where a contact was logged from, as ADIF APP_POTACAT_LOG_SOURCE (#634, based
// on w5lee's PR). Only ECHOCAT is marked: a contact logged at the station
// itself carries no source. The platform is the one the client put in its
// hello (lib/remote-server.js activeClientContext): 'web' for ECHOCAT Web,
// 'ios 18.1 iPhone' / 'android 34 android' for the phone app, and
// 'desktop-<os>' for a POTACAT desktop driving the station, which is not
// ECHOCAT and stays unmarked.

const ECHOCAT = 'ECHOCAT';

/** 'ECHOCAT' for a phone or ECHOCAT Web client's platform string, else ''. */
function logSourceForPlatform(platform) {
  return /^(ios|android|web)(?:\s|$)/i.test(String(platform || '')) ? ECHOCAT : '';
}

module.exports = { logSourceForPlatform, ECHOCAT };
