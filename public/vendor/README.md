# WNACG same-version dependency mirrors

WNACG synchronously loads jQuery 1.10.2 from upcdn.b0.upaiyun.com before
rendering its content. On 2026-10-04 this request took 19.49 seconds while
the main HTML completed in approximately 0.6 seconds; first contentful paint
was delayed until 20.18 seconds.

The search page instead loads jQuery 1.6.2 and jQuery UI 1.8.24 from the same
CDN, synchronously. On 2026-10-04 the supplied search page received its HTML
in 452.5 ms but had no paint after 77,882.1 ms waiting for jQuery 1.6.2.
Replacing both dependencies with their official same-version releases in a
browser comparison produced first contentful paint at 948 ms and load at
1,433.2 ms. The search input, autocomplete plugin, and all 25 images loaded.

The static Chrome declarativeNetRequest rules replace only these exact script
versions, only for requests initiated by wnacg.com or its subdomains, with
bundled, unmodified official releases. Static extensionPath is resolved
by Chrome against the installed extension; no extension ID or absolute
resource URL is hardcoded and no service worker startup is required.

- Source: https://code.jquery.com/jquery-1.10.2.min.js
- SHA-256: 0ba081f546084bd5097aa8a73c75931d5aa1fc4d6e846e53c21f98e6a1509988
- License: jquery-MIT-LICENSE.txt, from the official jQuery 1.10.2 tag.

## Search dependencies

- jQuery 1.6.2: https://code.jquery.com/jquery-1.6.2.min.js
- SHA-256: d16d07a0353405fcec95f7efc50a2621bc7425f9a5e8895078396fb0dc460c4f
- License: jquery-1.6.2-MIT-LICENSE.txt, from the official 1.6.2 tag.
- jQuery UI 1.8.24: https://code.jquery.com/ui/1.8.24/jquery-ui.min.js
- SHA-256: 50ea31c0452a869e41485170ab3ca8d90a7824b99860f4c707c97ed728598a3f
- License: jquery-ui-1.8.24-MIT-LICENSE.txt, from the official 1.8.24 tag.
- The original CDN response declared the same 200,719-byte jQuery UI build;
  its first 6,845 received bytes matched the official file exactly before
  that diagnostic download timed out. The entire original CDN file was
  not obtained for a full checksum comparison.

This is a compatibility mirror, not an upgrade of the site's dependency.
Do not redirect newer releases to these files or interchange jQuery versions.

The options page offers a WNACG acceleration switch that disables this entire
ruleset. Its saved chrome.storage.local preference is restored by the worker
at startup and after extension updates. Refresh the site after switching:
already executed scripts are not unloaded or replaced in the current page.
