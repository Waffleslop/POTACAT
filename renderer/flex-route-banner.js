// The Flex route banner: the main window and the VFO window.
//
// While the radio is with ECHOCAT through FlexRadio SmartLink
// (lib/flex-route.js 'released'), the top of the window says so and offers
// "Take it back", which warns first ("Your mobile device will lose the
// radio.") in the banner itself, never in a browser dialog. When a mobile
// device asks for the radio while someone is at the computer, the same banner
// asks the person here (Let it go / Keep it here), with the seconds left.
//
// Every sentence comes from main (lib/flex-route.js TEXT), so the banner, the
// log and the mobile device say the same thing. Device names go in with
// textContent only. Styles: flex-route-banner.css (theme tokens only).
(function () {
  'use strict';
  const api = window.api;
  if (!api || typeof api.flexRouteGet !== 'function') return;

  let route = null;      // last flex-route payload from main
  let ask = null;        // { id, who, until, text } while the desk is asked
  let warn = false;      // Take it back pressed once: the warning is showing
  let working = false;   // Take it back sent, waiting for main
  let error = '';        // the sentence from a failed Take it back
  let countTimer = null;
  let box = null;

  function mount() {
    if (box) return box;
    box = document.createElement('div');
    box.id = 'flex-route-banner';
    box.className = 'hidden';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    const tb = document.querySelector('.titlebar');
    if (tb && tb.parentNode) tb.insertAdjacentElement('afterend', box);
    else document.body.insertBefore(box, document.body.firstChild);
    return box;
  }

  function button(label, primary, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    return b;
  }

  function secondsLeft() {
    return ask ? Math.max(0, Math.ceil((ask.until - Date.now()) / 1000)) : 0;
  }

  function render() {
    const b = mount();
    b.textContent = '';
    if (countTimer && !ask) { clearInterval(countTimer); countTimer = null; }
    const msg = document.createElement('div');
    msg.className = 'frb-msg';
    const actions = document.createElement('div');
    actions.className = 'frb-actions';

    if (ask) {
      if (ask.who) {
        const who = document.createElement('strong');
        who.textContent = ask.who + ': ';
        msg.appendChild(who);
      }
      msg.appendChild(document.createTextNode(ask.text || ''));
      const count = document.createElement('span');
      count.className = 'frb-count';
      count.textContent = ' ' + secondsLeft() + ' s left.';
      msg.appendChild(count);
      actions.appendChild(button('Let it go', true, () => answer(true)));
      actions.appendChild(button('Keep it here', false, () => answer(false)));
      if (!countTimer) {
        countTimer = setInterval(() => {
          const c = box && box.querySelector('.frb-count');
          if (c) c.textContent = ' ' + secondsLeft() + ' s left.';
        }, 1000);
      }
    } else if (route && route.state === 'released') {
      msg.textContent = route.text || '';
      if (error) {
        const e = document.createElement('div');
        e.className = 'frb-error';
        e.textContent = error;
        msg.appendChild(e);
      }
      if (warn) {
        const w = document.createElement('div');
        w.className = 'frb-warn';
        w.textContent = route.warn || '';
        msg.appendChild(w);
        actions.appendChild(button('Take it back', true, takeBack));
        actions.appendChild(button('Cancel', false, () => { warn = false; render(); }));
      } else {
        actions.appendChild(button('Take it back', false, () => { warn = true; error = ''; render(); }));
      }
    } else if (route && route.state === 'reclaiming') {
      msg.textContent = 'POTACAT is taking the radio back from your mobile device.';
    } else if (route && route.state === 'releasing') {
      msg.textContent = 'POTACAT is handing the radio to your mobile device.';
    } else {
      b.className = 'hidden';
      return;
    }
    b.className = '';
    b.appendChild(msg);
    if (actions.childNodes.length) b.appendChild(actions);
  }

  function answer(yes) {
    if (!ask) return;
    const id = ask.id;
    ask = null;
    render();
    api.flexRouteAnswer(id, yes);
  }

  async function takeBack() {
    if (working) return;
    working = true;
    warn = false;
    error = '';
    route = Object.assign({}, route, { state: 'reclaiming' });
    render();
    try {
      const r = await api.flexRouteTakeBack();
      if (r && !r.ok && r.error) error = r.error;
    } catch (e) {
      error = 'POTACAT could not take the radio back.';
    }
    working = false;
    try { route = await api.flexRouteGet(); } catch { /* the next push corrects it */ }
    render();
  }

  api.onFlexRoute((d) => {
    route = d || null;
    if (!route || route.state !== 'released') warn = false;
    if (route && 'ask' in route) ask = route.ask || null;
    render();
  });
  api.onFlexRouteAsk((a) => { ask = a || null; render(); });
  api.onFlexRouteAskDone((d) => { if (ask && d && d.id === ask.id) { ask = null; render(); } });

  function start() {
    mount();
    api.flexRouteGet().then((d) => {
      route = d || null;
      ask = d && d.ask ? d.ask : null;
      render();
    }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
