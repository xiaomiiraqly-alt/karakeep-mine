# Instagram import (Karakeep Mine)

Save a public Instagram post, carousel, or Reel URL as an ordinary link
(\`https://www.instagram.com/p/...\` or \`/reel/...\`).

The crawler tries gallery-dl to download up to 20 pictures/videos, extracts
the post caption, saves the original files as Karakeep assets, and uses
FFmpeg to sample up to six video frames. Karakeep then runs its ordinary
tagging and summarization queues, enriching their prompts with up to
six AI descriptions of the saved images/video frames.

There is no speech transcription, full video understanding, or dedicated
carousel UI yet. The bookmark preview shows the first image/video.
Instagram access can be blocked by the platform; in that case this
integration falls back to normal web crawling, which can also fail.

## Deployment

The Dockerfile installs gallery-dl in the runtime image and already includes
FFmpeg. This repository is a fork; you must build **your own** Docker image
and update your existing Compose service to use it. Merely merging this PR
does not update the deployed container.

From the repository root:

    docker build --target aio -t karakeep-instagram:local -f docker/Dockerfile .

Recommended environment values for Instagram downloads:

    CRAWLER_JOB_TIMEOUT_SEC=300
    INFERENCE_JOB_TIMEOUT_SEC=180

Imports also respect Karakeep's MAX_ASSET_SIZE_MB (50 MB by default),
the storage quota, 80 MB per individual media file, and 250 MB per batch.

If anonymous requests fail and your Instagram account is authorized to access
the content, you may supply your own Netscape-format cookies file. Keep it
outside GitHub, mount it **read-only** into the container, and configure:

    KARAKEEP_INSTAGRAM_COOKIES_FILE=/run/secrets/instagram-cookies.txt

Do not commit cookies, passwords, session tokens, or authentication headers.
Some restricted posts will not be accessible even with cookies. Check
Instagram's terms and applicable copyright/usage permissions before storing
third-party material.

Before deployment, back up Karakeep's data and verify the custom image
starts successfully. Test a public single-image post, a carousel, and a Reel.
