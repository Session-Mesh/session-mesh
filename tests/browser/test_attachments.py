# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The 📎 attachment menu: what it offers on a phone and on a computer, the attributes of
each file input, a chosen file reaching the session, and the webcam and microphone flows
(Chromium's fake devices): preview first, nothing uploaded before "Send", every track
stopped afterwards."""

import os
from fnmatch import fnmatch
from pathlib import Path

import pytest

import server
from test_sidebar_menu import PHONE, api
from test_view_compat import goto
from conftest import ui

pytestmark = pytest.mark.usefixtures("pty")

DESKTOP = {"viewport": {"width": 1000, "height": 700}}
FAKE_MEDIA = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
MENU_ITEMS = "#attach-menu [role=menuitem]"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
EBML_MAGIC = b"\x1a\x45\xdf\xa3"   # a webm (matroska) file starts with it

# every stream the page opens, to check afterwards that its tracks ended
TRACK_SPY = """
window.__streams = [];
const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (c) => { const s = await real(c); window.__streams.push(s); return s; };
"""
TRACKS_ENDED = "window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"
UPLOAD_RESPONSE_SPY = """(() => {
  window.__uploadResults = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url, location.href).pathname === '/api/upload') {
      response.clone().text().then((text) => {
        let payload;
        try { payload = JSON.parse(text); } catch { payload = {error: text}; }
        window.__uploadResults.push({status: response.status, payload});
      }).catch((error) => window.__uploadResults.push({status: response.status, payload: {error: String(error)}}));
    }
    return response;
  };
})()"""


@pytest.fixture
async def media_browser():
    """Chromium with fake camera and microphone, auto-accepting the permission prompt: only these tests."""
    from playwright.async_api import async_playwright
    from conftest import DEFAULT_CHROMIUM, localized

    executable = os.environ.get("MESH_CHROMIUM") or (DEFAULT_CHROMIUM if Path(DEFAULT_CHROMIUM).exists() else None)
    async with async_playwright() as playwright:
        instance = localized(await playwright.chromium.launch(executable_path=executable, headless=True,
                                                              args=[*FAKE_MEDIA, "--mute-audio"]))
        yield instance
        await instance.close()


@pytest.fixture
async def attach_mesh(mesh, home_dir):
    contexts = []

    async def open_mesh(browser, options, spy=False):
        await api(mesh, "/api/new", {"preset": "shell", "cwd": str(home_dir), "name": "att"})
        context = await browser.new_context(**options)
        contexts.append(context)
        await context.add_cookies([{"name": server.COOKIE, "value": server.cookie_value(), "url": mesh.origin}])
        await context.add_init_script(UPLOAD_RESPONSE_SPY)
        if spy:
            await context.add_init_script(TRACK_SPY)
        tab = await context.new_page()
        tab.uploads = []
        tab.on("request", lambda r: tab.uploads.append(r) if "/api/upload" in r.url else None)
        await goto(tab, mesh.origin + "/")
        # The sidebar is drawn on the frame after a listing is applied: wait for the drawn row.
        await tab.wait_for_function("document.querySelector('#list .item[data-id=\"att\"]') !== null", timeout=10000)
        if options.get("is_mobile"):
            await tab.evaluate("document.querySelector('#list .item[data-id=\"att\"]').click()")
        else:
            await tab.click('#list .item[data-id="att"]')
        await tab.wait_for_function("active?.conn?.ws?.readyState === 1", timeout=10000)
        return tab

    yield open_mesh
    for context in contexts:
        await context.close()


async def open_menu(tab, phone):
    if phone:
        try:
            await tab.tap('#keys [data-k="file"]')
        except Exception as error:
            # Keep the original failure; capture only synthetic UI geometry,
            # not terminal contents, credentials or request data.
            try:
                state = await tab.evaluate("""() => ({
              touch, hoverNone: matchMedia('(hover: none)').matches,
              keysHidden: document.querySelector('#keys').hidden,
              keysDisplay: getComputedStyle(document.querySelector('#keys')).display,
              bodyClasses: document.body.className,
              connected: active?.conn?.ws?.readyState,
              viewport: [innerWidth, innerHeight]
                })""")
                error.add_note(f"Phone attachment state: {state!r}")
            except Exception as diagnostic_error:
                error.add_note(f"Phone attachment state unavailable: {type(diagnostic_error).__name__}")
            raise
    else:
        await tab.click('.pane.active [data-act="more"]')
        await tab.get_by_role("menuitem", name=ui("paneActions.action.file")).click()
    await tab.wait_for_selector("#dlg-attach[open]")


@pytest.mark.parametrize("closed_page", [False, True])
async def test_phone_menu_diagnostics_preserve_original_failure(closed_page):
    failure = TimeoutError("synthetic invisible attachment button")

    class FailedTab:
        async def tap(self, selector):
            raise failure

        async def evaluate(self, script):
            if closed_page:
                raise RuntimeError("synthetic closed page")
            return {"touch": True, "keysHidden": True}

    with pytest.raises(TimeoutError) as result:
        await open_menu(FailedTab(), phone=True)
    assert result.value is failure
    expected = "state unavailable: RuntimeError" if closed_page else "'keysHidden': True"
    assert expected in failure.__notes__[0]


async def labels(tab):
    return await tab.eval_on_selector_all(MENU_ITEMS, "(els) => els.map((e) => e.dataset.attach)")


async def attributes(tab, selector):
    return await tab.eval_on_selector(selector, "(e) => ({accept: e.getAttribute('accept'), capture: e.getAttribute('capture'), multiple: e.multiple})")


async def stored_upload(tab, pattern):
    """Read the path the completed upload response published, not its early directory entry."""
    for _ in range(100):
        for result in await tab.evaluate("window.__uploadResults"):
            status, payload = result["status"], result["payload"]
            if status != 200:
                raise AssertionError(f"upload failed with HTTP {status}: {payload}")
            path = Path(payload["path"])
            if fnmatch(path.name, pattern):
                assert path.is_relative_to(server.UPLOAD_DIR)
                return path.name, path.read_bytes()
        await tab.wait_for_timeout(100)
    raise AssertionError(f"no completed upload response for {pattern!r}")


async def test_stored_upload_waits_for_response_even_when_final_name_exists_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "UPLOAD_DIR", tmp_path)
    path = tmp_path / "2026-10-08" / "gallery-pick.txt"
    path.parent.mkdir()
    path.write_bytes(b"")  # _store_upload creates its final name before writing.

    class Tab:
        results = []
        waits = 0

        async def evaluate(self, _expression):
            return self.results

        async def wait_for_timeout(self, _delay):
            self.waits += 1
            path.write_bytes(b"hello attachment")
            self.results.append({"status": 200, "payload": {"path": str(path)}})

    tab = Tab()
    assert await stored_upload(tab, "gallery-pick*.txt") == (path.name, b"hello attachment")
    assert tab.waits == 1


async def test_phone_menu_offers_camera_gallery_file_and_microphone(browser, attach_mesh):
    tab = await attach_mesh(browser, PHONE)
    await open_menu(tab, phone=True)
    assert await labels(tab) == ["camera", "gallery", "file", "mic"]
    assert await tab.inner_text(f'{MENU_ITEMS}[data-attach=camera]') == ui("attach.camera")
    assert await tab.inner_text(f'{MENU_ITEMS}[data-attach=gallery]') == ui("attach.gallery")


async def test_desktop_menu_offers_file_webcam_and_microphone(browser, attach_mesh):
    tab = await attach_mesh(browser, DESKTOP)
    await open_menu(tab, phone=False)
    assert await labels(tab) == ["file", "webcam", "mic"]


async def test_each_file_input_carries_its_accept_and_capture(browser, attach_mesh):
    tab = await attach_mesh(browser, DESKTOP)
    assert await attributes(tab, "#camera-input") == {"accept": "image/*", "capture": "environment", "multiple": False}
    assert await attributes(tab, "#gallery-input") == {"accept": "image/*,video/*", "capture": None, "multiple": True}
    assert await attributes(tab, "#file-input") == {"accept": None, "capture": None, "multiple": True}


async def test_capture_options_are_hidden_without_media_devices(browser, attach_mesh):
    tab = await attach_mesh(browser, DESKTOP)
    await tab.evaluate("Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })")
    await open_menu(tab, phone=False)
    assert await labels(tab) == ["file"]


async def test_microphone_is_hidden_without_media_recorder(browser, attach_mesh):
    tab = await attach_mesh(browser, DESKTOP)
    await tab.evaluate("window.MediaRecorder = undefined")
    await open_menu(tab, phone=False)
    assert await labels(tab) == ["file", "webcam"]


@pytest.mark.parametrize("phone, item, selector", [
    (False, "file", "#file-input"),
    (True, "camera", "#camera-input"),
    (True, "gallery", "#gallery-input"),
])
async def test_a_chosen_file_is_uploaded_and_its_path_typed_into_the_session(browser, attach_mesh, tmp_path, phone, item, selector):
    tab = await attach_mesh(browser, PHONE if phone else DESKTOP)
    await open_menu(tab, phone)
    async with tab.expect_file_chooser() as chooser:
        await tab.click(f"{MENU_ITEMS}[data-attach={item}]")
    assert not await tab.evaluate("document.getElementById('dlg-attach').open")   # the system picker took over
    picked = tmp_path / f"{item}-pick.txt"
    picked.write_bytes(b"hello attachment")
    await (await chooser.value).set_files(picked)
    name, body = await stored_upload(tab, f"{item}-pick*.txt")
    assert name.startswith(f"{item}-pick") and body == b"hello attachment"
    [path] = list(server.UPLOAD_DIR.rglob(name))
    # the path is long: the terminal wraps it, so look at the rows joined
    await tab.wait_for_function("(p) => { const b = active.term.buffer.active; let t = '';"
                                " for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true); return t.includes(p); }",
                                arg=str(path), timeout=10000)


async def shot(tab, name):
    out = Path(os.environ.get("ATTACH_SHOTS", "")) if os.environ.get("ATTACH_SHOTS") else None
    if out:
        await tab.screenshot(path=str(out / f"{name}.png"))


async def test_webcam_capture_previews_then_uploads_a_png_and_stops_the_camera(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, DESKTOP, spy=True)
    await open_menu(tab, phone=False)
    await shot(tab, "desktop-menu")
    await tab.click(f"{MENU_ITEMS}[data-attach=webcam]")
    await tab.wait_for_function("document.querySelector('#cap-video').videoWidth > 0", timeout=10000)
    await tab.wait_for_selector(f"#cap-main:has-text('{ui('capture.take')}')")
    await shot(tab, "desktop-webcam-preview")
    assert await tab.evaluate("window.__streams.length") == 1
    assert not await tab.evaluate(TRACKS_ENDED)   # the camera is on while previewing
    await tab.click("#cap-main")
    await tab.wait_for_selector("#cap-image:not([hidden])")
    await shot(tab, "desktop-webcam-review")
    assert await tab.evaluate(TRACKS_ENDED)   # off as soon as the picture is taken
    assert tab.uploads == []   # nothing is uploaded before "Send"
    await tab.click("#cap-send")
    await tab.wait_for_function("document.getElementById('dlg-attach').open === false")
    name, body = await stored_upload(tab, "webcam-*.png")
    assert name.startswith("webcam-") and name.endswith(".png")
    assert body.startswith(PNG_MAGIC) and len(body) > 1000


async def test_webcam_cancel_uploads_nothing_and_stops_the_camera(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, DESKTOP, spy=True)
    await open_menu(tab, phone=False)
    await tab.click(f"{MENU_ITEMS}[data-attach=webcam]")
    await tab.wait_for_function("document.querySelector('#cap-video').videoWidth > 0", timeout=10000)
    assert not await tab.evaluate(TRACKS_ENDED)
    await tab.click("#cap-cancel")
    await tab.wait_for_function(TRACKS_ENDED)
    assert await tab.evaluate("document.querySelector('#cap-video').srcObject") is None
    await tab.wait_for_timeout(500)
    assert tab.uploads == []


async def test_escape_closes_the_dialog_and_stops_the_camera(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, DESKTOP, spy=True)
    await open_menu(tab, phone=False)
    await tab.click(f"{MENU_ITEMS}[data-attach=webcam]")
    await tab.wait_for_function("document.querySelector('#cap-video').videoWidth > 0", timeout=10000)
    await tab.keyboard.press("Escape")
    await tab.wait_for_function("document.getElementById('dlg-attach').open === false")
    await tab.wait_for_function(TRACKS_ENDED)
    assert tab.uploads == []


async def test_microphone_listens_only_after_enregistrer_shows_a_state_and_uploads_a_webm(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, DESKTOP, spy=True)
    await open_menu(tab, phone=False)
    await tab.click(f"{MENU_ITEMS}[data-attach=mic]")
    await tab.wait_for_selector(f"#cap-main:has-text('{ui('capture.record')}')")
    assert await tab.evaluate("window.__streams.length") == 0   # nothing is captured before the click
    await tab.click("#cap-main")
    await tab.wait_for_selector("#cap-rec:not([hidden])")
    assert ui("capture.recording", minutes=5) in await tab.inner_text("#cap-status")
    assert not await tab.evaluate(TRACKS_ENDED)
    await shot(tab, "desktop-mic-recording")
    await tab.wait_for_function("document.querySelector('#cap-time').textContent !== '0:00'", timeout=5000)
    await tab.click(f"#cap-main:has-text('{ui('capture.stop')}')")
    await tab.wait_for_selector("#cap-audio:not([hidden])")
    assert await tab.evaluate(TRACKS_ENDED)   # the microphone is released when the recording ends
    assert tab.uploads == []
    await shot(tab, "desktop-mic-review")
    await tab.click("#cap-send")
    name, body = await stored_upload(tab, "mic-*")
    assert name.startswith("mic-") and name.endswith((".webm", ".ogg"))
    assert body.startswith(EBML_MAGIC) and len(body) > 100


async def test_microphone_cancel_while_recording_uploads_nothing_and_releases_it(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, DESKTOP, spy=True)
    await open_menu(tab, phone=False)
    await tab.click(f"{MENU_ITEMS}[data-attach=mic]")
    await tab.click(f"#cap-main:has-text('{ui('capture.record')}')")
    await tab.wait_for_selector("#cap-rec:not([hidden])")
    await tab.click("#cap-cancel")
    await tab.wait_for_function(TRACKS_ENDED)
    await tab.wait_for_timeout(500)
    assert tab.uploads == []
    await open_menu(tab, phone=False)   # and the dialog opens fresh, on the menu
    assert await labels(tab) == ["file", "webcam", "mic"]


async def test_denied_camera_says_so_instead_of_failing(browser, attach_mesh):
    tab = await attach_mesh(browser, DESKTOP)   # plain Chromium: no fake device, no auto-accept
    await tab.evaluate("() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError')); }")
    await open_menu(tab, phone=False)
    await tab.click(f"{MENU_ITEMS}[data-attach=webcam]")
    await tab.wait_for_function("document.querySelector('#cap-status').textContent.includes('NotAllowedError')")
    assert tab.uploads == []


async def test_the_dialog_fits_a_phone_screen(media_browser, attach_mesh):
    tab = await attach_mesh(media_browser, PHONE)
    await open_menu(tab, phone=True)
    await shot(tab, "phone-menu")
    assert await tab.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await tab.click(f"{MENU_ITEMS}[data-attach=mic]")
    await tab.click(f"#cap-main:has-text('{ui('capture.record')}')")
    await tab.wait_for_selector("#cap-rec:not([hidden])")
    await shot(tab, "phone-mic-recording")
    box = await tab.evaluate("(() => { const r = document.getElementById('dlg-attach').getBoundingClientRect(); return [r.left, r.right]; })()")
    assert 0 <= box[0] and box[1] <= 390
