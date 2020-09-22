console.log('[google-meet-transcripts] loaded');

try {

;(() => {
  ////////////////////////////////////////////////////////////////////////////
  // Variables
  ////////////////////////////////////////////////////////////////////////////

  // DOM node where Google Meet puts its closed captions
  let captionsContainer  = null;

  // The interval for attaching to the closed captions node. Once attached,
  // this can be cleared
  let closedCaptionsAttachInterval = null;

  // set to true when we are recording transcriptions
  let isTranscribing = false;

  // set to true if we turned on closed captions so we know to disable them
  // when we stop transcribing
  let weTurnedCaptionsOn = false;

  // used for tracking the current position in the transcription
  let currentTranscriptId = null;
  let currentSessionIndex = null;
  // now isolated to updateCurrentMeetingSession
  // let currentSpeakerIndex = null;

  // set to the interval object, will stop when the transcription starts
  let transcribeOnBootInterval = null;

  // -------------------------------------------------------------------------
  // CACHE is an array of speakers and comments
  //
  // each entry contains:
  //   Speaker name, avatar, and comment
  //     person
  //     image
  //     text
  //
  //   Start and end timestamps of comment
  //     startedAt
  //     endedAt
  //
  //   Used to generate key when writing to local storage
  //     speakerIndex
  //
  //   Stored for tracking / debugging
  //     node
  //     count
  //     pollCount
  // -------------------------------------------------------------------------
  const CACHE = [];

  ////////////////////////////////////////////////////////////////////////////
  // Constants (excluding SVG, XPATH_SELECTOR, COLOR, and STYLE)
  ////////////////////////////////////////////////////////////////////////////

  // id of `svg` element of toggle button
  // used to apply the `on` class which alters the fill color of the path
  const ID_TOGGLE_BUTTON = '__gmt-icon';

  // List of ids for all recorded hangouts
  const KEY_TRANSCRIPT_IDS = 'hangouts';

  // Used to identify when the user is the speaker when listing the meeting participants
  const SEARCH_TEXT_SPEAKER_NAME_YOU = 'You';

  // Used to identify when a meeting has no name
  const SEARCH_TEXT_NO_MEETING_NAME = 'Meeting details';

  // Search through this many comments when determining meeting participants
  const MAX_PARTICIPANT_SEARCH_DEPTH = 1000;

  // Label given to conversations with no other participants
  const NAME_YOURSELF = 'yourself';

  // Version of the format for localstorage data
  const LOCALSTORAGE_VERSION = 1;

  // These need to be defined below (after getOrSet is defined) because they
  // depened on that function. They're no longer constants, but they should
  // never be changed except when syncing settings.
  let SPEAKER_NAME_MAP;
  let TRANSCRIPT_FORMAT_SPEAKER;
  let TRANSCRIPT_FORMAT_SPEAKER_JOIN;
  let TRANSCRIPT_FORMAT_SESSION_JOIN;
  let TRANSCRIPT_FORMAT_MEETING;
  let DEBUG;
  let READONLY;
  // let HIDE_CAPTIONS_WHILE_RECORDING;

  ////////////////////////////////////////////////////////////////////////////
  // Local storage persistence
  //
  // Prefix for all keys: __gmt_v1_
  //  (__gmt_ when version is null, e.g. '_gmt_version')
  //
  // setting.speaker-format -> the formatting string used when copying
  //                            conversations to the cliboard
  //                            default: **HH:MM Name:** comment\n
  //
  // setting.speaker-name-map -> speaker names can be altered when copying
  //                              conversations. Names matching keys in this
  //                              object will be mapped to their respective
  //                              values
  //
  // hangouts = [<id>, ...]
  //
  // hangout_<id> = number of sessions
  //
  // hangout_<id>_session_<index> = number of speakers
  //
  // hangout_<id>_session_<index>_speaker_<index> = {
  //   person     the name of the speaker
  //   image      the url to the speaker's avatar
  //   text       the final transcription of the speaker's comment
  //   startedAt  when the speaker began making this comment
  //   endedAt    when the speaker finished making this comment
  // }
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // make a localStorage key with the version prefixed
  // -------------------------------------------------------------------------
  const makeFullKey = (key, version = LOCALSTORAGE_VERSION) => {
    let versionPostfix = version === null ? '' : `_v${version}`;
    return `__gmt${versionPostfix}_${key}`;
  };

  // -------------------------------------------------------------------------
  // make a localStorage key for hangouts following the format above
  // -------------------------------------------------------------------------
  const makeTranscriptKey = (...args) => {
     const [transcriptId, sessionIndex, speakerIndex] = args;

    const keyParts = [`hangout_${transcriptId}`];

    if (args.length >= 2) {
      keyParts.push(`session_${sessionIndex}`);

      if (args.length >= 3) {
        keyParts.push(`speaker_${speakerIndex}`);
      }
    }

    return keyParts.join('_');
  };

  // -------------------------------------------------------------------------
  // retrieve a key from localStorage parsed as JSON
  // -------------------------------------------------------------------------
  const get = (key, version) => {
    const raw = window.localStorage.getItem(makeFullKey(key, version));
    if (typeof raw === 'string' || raw instanceof String) {
      debug(key, raw);
      return JSON.parse(raw);
    } else {
      return raw;
    }
  };

  // -------------------------------------------------------------------------
  // retrieve a key in localStorage stringified as JSON
  // -------------------------------------------------------------------------
  const set = (key, value, version) => {
    window.localStorage.setItem(makeFullKey(key, version), JSON.stringify(value));
  };

  // -------------------------------------------------------------------------
  // delete a key from localStorage
  // -------------------------------------------------------------------------
  const remove = (key, version) => {
    debug(`remove ${makeFullKey(key, version)}`);

    if (!READONLY) {
      window.localStorage.removeItem(makeFullKey(key, version));
    }
  };

  // -------------------------------------------------------------------------
  // get a key from local storage and set it to the default if it doesn't
  // exist yet
  // -------------------------------------------------------------------------
  const getOrSet = (key, defaultValue, version) => {
    const value = get(key, version);

    if (value === undefined || value === null) {
      set(key, defaultValue, version);
      return defaultValue;
    } else {
      return value;
    }
  }

  // -------------------------------------------------------------------------
  // increment a key in local storage, set to to 0 if it doesn't exist
  // -------------------------------------------------------------------------
  const increment = (key, version) => {
    const current = get(key, version);

    if (current === undefined || current === null) {
      set(key, 0);
      return 0;
    } else {
      let next = current + 1;
      set(key, next);
      return next;
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  // Settings
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // public getter
  // -------------------------------------------------------------------------
  window.__gmt_get = (key) => {
    return get(`setting.${key}`);
  };

  // -------------------------------------------------------------------------
  // public setter
  // -------------------------------------------------------------------------
  window.__gmt_set = (key, value) => {
    set(`setting.${key}`, value);
    syncSettings();
  };

  // -------------------------------------------------------------------------
  // public deleter
  // -------------------------------------------------------------------------
  window.__gmt_remove = (key) => {
    remove(`setting.${key}`);
    syncSettings();
  };

  // -------------------------------------------------------------------------
  // sync settings from localStorage
  // -------------------------------------------------------------------------
  const syncSettings = () => {
    TRANSCRIPT_FORMAT_MEETING = getOrSet('setting.transcript-format-meeting', '# $year$-$month$-$day$ $name$\n\n$text$');
    TRANSCRIPT_FORMAT_SESSION_JOIN = getOrSet('setting.transcript-format-session-join', '\n\n...\n\n');
    TRANSCRIPT_FORMAT_SPEAKER = getOrSet('setting.transcript-format-speaker', '**$hour$:$minute$ $name$:** $text$');
    TRANSCRIPT_FORMAT_SPEAKER_JOIN = getOrSet('setting.transcript-format-speaker-join', '\n\n');
    SPEAKER_NAME_MAP = getOrSet('setting.speaker-name-map', {});
    DEBUG = getOrSet('setting.debug', false);
    READONLY = getOrSet('setting.readonly', false);
    // HIDE_CAPTIONS_WHILE_RECORDING = get('gmt-setting.hide-captions-while-recording');
  };

  ////////////////////////////////////////////////////////////////////////////
  // DOM Utilities
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // create a list of all ancestor nodes
  // -------------------------------------------------------------------------
  const parents = (node) => {
    const nodes = [node]
    for (; node; node = node.parentNode) {
      nodes.unshift(node);
    }
    return nodes;
  }

  // -------------------------------------------------------------------------
  // find the common ancestor of two nodes if one exists
  // -------------------------------------------------------------------------
  const getCommonAncestor = (node1, node2) => {
    const parents1 = parents(node1);
    const parents2 = parents(node2);

    if (parents1[0] === parents2[0]) {
      for (let i = 0; i < parents1.length; i++) {
        if (parents1[i] !== parents2[i]) {
          return parents1[i - 1];
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // execute an xpath query and return the first matching node
  // -------------------------------------------------------------------------
  const xpath = (search, root = document) => {
    return document.evaluate(search, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue;
  };

  ////////////////////////////////////////////////////////////////////////////
  // General utilities
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // pad numbers 0-9 with 0
  // -------------------------------------------------------------------------
  const pad = (integer) => {
    if (integer < 10) {
      return `0${integer}`;
    } else {
      return integer;
    }
  };

  // -------------------------------------------------------------------------
  // console.log only if DEBUG is false
  // -------------------------------------------------------------------------
  const debug = (...args) => {
    if (DEBUG) {
      console.log('[google-meet-transcripts]', ...args);
    }
  };

  // -------------------------------------------------------------------------
  // await the function and return its value, logging an error if it rejects
  // -------------------------------------------------------------------------
  const tryTo = (fn, label) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(`error ${label}:`, e);
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // Caption Controls
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Turn Google's captions on
  // -------------------------------------------------------------------------
  const turnCaptionsOn = () => {
    const captionsButtonOn = xpath(`//div[text()='Turn on captions']/ancestor::div[@role='button']`, document);
    if (captionsButtonOn) {
      captionsButtonOn.click();
      weTurnedCaptionsOn = true;
    }
  }

  // -------------------------------------------------------------------------
  // Turn Google's captions off
  // -------------------------------------------------------------------------
  const turnCaptionsOff = () => {
    const captionsButtonOff = xpath(`//div[text()='Turn off captions']/ancestor::div[@role='button']`, document);

    if (captionsButtonOff) {
      captionsButtonOff.click();
      weTurnedCaptionsOn = false;
    }
  }

  ////////////////////////////////////////////////////////////////////////////
  // Transcribing Controls
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Stop transcribing
  // -------------------------------------------------------------------------
  const stopTranscribing = () => {
    clearInterval(closedCaptionsAttachInterval)
    closedCaptionsAttachInterval = null;
    captionContainerChildObserver.disconnect();
    captionContainerAttributeObserver.disconnect();

    document.querySelector(`#${ID_TOGGLE_BUTTON}`).classList.remove('on');

    if (weTurnedCaptionsOn) {
      turnCaptionsOff();
      weTurnedCaptionsOn = false;
    }
  }

  // -------------------------------------------------------------------------
  // Start transcribing
  // -------------------------------------------------------------------------
  const startTranscribing = () => {
    if (closedCaptionsAttachInterval) {
      clearInterval(closedCaptionsAttachInterval);
    }

    // set this to null to force it to increment
    currentSessionIndex = null;

    closedCaptionsAttachInterval = setInterval(tryTo(closedCaptionsAttachLoop, 'attach to captions'), 1000);
    setCurrentTranscriptDetails();

    document.querySelector(`#${ID_TOGGLE_BUTTON}`).classList.add('on');

    turnCaptionsOn();
  }

  // -------------------------------------------------------------------------
  // Toggle transcribing - invoked by `onclick` so the action doesn't need to
  // be updated each click
  // -------------------------------------------------------------------------
  const toggleTranscribing = () => {
    isTranscribing ? stopTranscribing() : startTranscribing()
    isTranscribing = !isTranscribing;
  }

  ////////////////////////////////////////////////////////////////////////////
  // Transcript reading, writing, and deleting
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Copy all of the speakers for each session of a transcript to clipboard
  //
  // Uses the format TRANSCRIPT_FORMAT_SPEAKER (setting.speaker-format) and the speaker
  // name map SPEAKER_NAME_MAP (settiong.speaker-name-map).
  // -------------------------------------------------------------------------
  const getTranscript = (transcriptId) => {
    const maxSessionIndex = get(makeTranscriptKey(transcriptId)) || 0;

    const transcript = [];

    for (let sessionIndex = 0; sessionIndex <= maxSessionIndex; sessionIndex += 1) {
      const maxSpeakerIndex = get(makeTranscriptKey(transcriptId, sessionIndex)) || 0;

      const speakers = [];

      for (let speakerIndex = 0; speakerIndex <= maxSpeakerIndex; speakerIndex += 1) {
        const item = get(makeTranscriptKey(transcriptId, sessionIndex, speakerIndex));

        if (item && item.text && item.text.match(/\S/g)) {
          const date = new Date(item.startedAt);
          const minutes = date.getMinutes();
          const seconds = date.getSeconds();

          const name = item.person in SPEAKER_NAME_MAP ? SPEAKER_NAME_MAP[item.person] : item.person;

          const text = TRANSCRIPT_FORMAT_SPEAKER
            .replace('$hour$', date.getHours())
            .replace('$minute$', pad(minutes))
            .replace('$second$', pad(seconds))
            .replace('$name$', name)
            .replace('$text$', item.text);
          speakers.push(text);
        }
      }

      const sessionTranscript = speakers.join(TRANSCRIPT_FORMAT_SPEAKER_JOIN);

      if (sessionTranscript) {
        transcript.push(sessionTranscript);
      }
    }

    const {
      name,
      year,
      month,
      day,
    } = getTranscriptNameParts(transcriptId);

    return TRANSCRIPT_FORMAT_MEETING
      .replace('$year$', year)
      .replace('$month$', pad(month))
      .replace('$day$', pad(day))
      .replace('$name$', name)
      .replace('$text$', transcript.join(TRANSCRIPT_FORMAT_SESSION_JOIN));
  };

  // -------------------------------------------------------------------------
  // Generates a list of names sorted by number of individual comments based
  // on the first 100 comments
  // -------------------------------------------------------------------------
  const getTranscriptDetails = (transcriptId) => {
    const maxSessionIndex = get(makeTranscriptKey(transcriptId));

    const nameCounts = {};
    const spokenDuration = {};
    let count = 0;
    let minTime = null;

    for (let sessionIndex = 0; sessionIndex <= maxSessionIndex && count < MAX_PARTICIPANT_SEARCH_DEPTH; sessionIndex += 1) {
      const maxSpeakerIndex = get(makeTranscriptKey(transcriptId, sessionIndex));

      for (let speakerIndex = 0; speakerIndex <= maxSpeakerIndex && count < MAX_PARTICIPANT_SEARCH_DEPTH; speakerIndex += 1) {
        const data = get(makeTranscriptKey(transcriptId, sessionIndex, speakerIndex));

        if (!data) {
          continue;
        }

        count += 1;

        // We want to see our stats too
        /*
        if (data.person === SEARCH_TEXT_SPEAKER_NAME_YOU) {
          continue;
        }
        */

        if (!(data.person in nameCounts)) {
          nameCounts[data.person] = 0;
          spokenDuration[data.person] = 0;
        }

        nameCounts[data.person] += 1;

        if (minTime === null) {
          minTime = new Date(data.startedAt);
        }
        spokenDuration[data.person] += Math.abs(new Date(data.endedAt) - minTime);
        minTime = new Date(data.endedAt);

        // TODO fix duration formula, but this isn't right either
        // spokenDuration[data.person] += Math.abs(new Date(data.endedAt) - new Date(data.startedAt));
      }
    }

    const people = Object.keys(nameCounts);

    people.sort((a, b) => {
      if (nameCounts[a] > nameCounts[b]) {
        return 1;
      } else if (nameCounts[a] < nameCounts[b]) {
        return -1;
      } else {
        return 0;
      }
    });

    return {
      hasRecords: count > 0,
      people: people.length ? people : [NAME_YOURSELF],
      minTime,
      spokenDuration,
    };
  };

  // -------------------------------------------------------------------------
  // Update the localStorage entry for this transcript + session + speaker
  // -------------------------------------------------------------------------
  const setSpeaker = (cache) => {
    set(makeTranscriptKey(cache.transcriptId, cache.sessionIndex, cache.speakerIndex), {
      image: cache.image,
      person: cache.person,
      text: cache.text,
      startedAt: cache.startedAt,
      endedAt: cache.endedAt,
    });
  };

  // -------------------------------------------------------------------------
  // Delete all localStorage entries related to a specific transcript
  // -------------------------------------------------------------------------
  const deleteTranscript = (transcriptId) => {
    const maxSessionIndex = get(makeTranscriptKey(transcriptId));

    for (let sessionIndex = 0; sessionIndex <= maxSessionIndex; sessionIndex += 1) {
      const maxSpeakerIndex = get(makeTranscriptKey(transcriptId, sessionIndex));

      for (let speakerIndex = 0; speakerIndex <= maxSpeakerIndex; speakerIndex += 1) {
        remove(makeTranscriptKey(transcriptId, sessionIndex, speakerIndex));
      }

      remove(makeTranscriptKey(transcriptId, sessionIndex));
    }

    remove(makeTranscriptKey(transcriptId));

    const transcriptIds = get(KEY_TRANSCRIPT_IDS) || [];
    const index = transcriptIds.indexOf(transcriptId);

    debug('would set transcript to', [...transcriptIds.slice(0, index), ...transcriptIds.slice(index + 1)]);
    if (!READONLY) {
      set(KEY_TRANSCRIPT_IDS, [...transcriptIds.slice(0, index), ...transcriptIds.slice(index + 1)]);
    }

    const transcriptNode = document.querySelector(`#${transcriptId}`);
    if (transcriptNode) {
      const parentNode = transcriptNode.parentNode;
      parentNode.removeChild(transcriptNode);

      if (parentNode.children.length === 0) {
        parentNode.parentNode.removeChild(parentNode.previousSibling);
        parentNode.parentNode.removeChild(parentNode);
      }
    } else {
      debug(`transcriptNode doesn't exist for ${transcriptId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete all transcript-specific localStorage entries
  // -------------------------------------------------------------------------
  const deleteTranscripts = () => {
    const transcriptIds = get(KEY_TRANSCRIPT_IDS) || [];

    for (let transcriptId of transcriptIds) {
      deleteTranscript(transcriptId);
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // transcript and session identification
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Find meeting name from footer
  // -------------------------------------------------------------------------
  const getMeetingName = () => {
    const name = xpath(`//*[text()='keyboard_arrow_up']/../..//div[@jscontroller!='']/text()`);

    if (name && name.data !== SEARCH_TEXT_NO_MEETING_NAME) {
      return name.data;
    }
  };

  // -------------------------------------------------------------------------
  // Identify the current transcript id based on the URL. Invoked whenever we
  // start trancribing.
  // -------------------------------------------------------------------------
  const setCurrentTranscriptDetails = () => {
    const now = new Date();
    const dateString = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const pathString = document.location.pathname.match(/\/(.+)/)[1];
    const newTranscriptId = `${pathString}-${dateString}`;
    const isTranscriptIdChanged = newTranscriptId !== currentTranscriptId;

    if (isTranscriptIdChanged || currentSessionIndex === null) {
      currentTranscriptId = newTranscriptId;

      const transcriptIds = get(KEY_TRANSCRIPT_IDS) || [];

      if (!transcriptIds.includes(currentTranscriptId)) {
        transcriptIds.unshift(currentTranscriptId);
        set(KEY_TRANSCRIPT_IDS, transcriptIds);
      }

      currentSessionIndex = increment(`hangout_${currentTranscriptId}`);

      debug({ currentTranscriptId, currentSessionIndex });;

      if (isTranscriptIdChanged) {
        const name = getMeetingName();
        if (name) {
          set(`${makeTranscriptKey(currentTranscriptId)}_name`, name);
        }
      }
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // Captions element processing
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Grab the speaker details and comment text for a caption node
  // -------------------------------------------------------------------------
  const getCaptionData = (node) => {
    const image = node.querySelector('img');
    const person = xpath('.//div/text()', node);
    const spans = Array.from(node.querySelectorAll('span')).filter((span) => span.children.length === 0);
    const text = spans.map((span) => span.textContent).join(' ');

    return {
      image: image.src,
      person: person.textContent,
      text,
    };
  };

  // -------------------------------------------------------------------------
  // process a change to a caption node
  //
  // If the nodes isn't being tracked yet, grab the full comment text, start
  // tracking the node, and start polling to record and save changes. The
  // goal is minimize the performance impact by capturing and saving the
  // comment once at the beginning, once at the end, and every 1 second
  // inbetween. This is reduces the amount of work done significantly for
  // longer comments.
  //
  // NOTE: It could be adjusted to only act on the last debounce if there was
  // not already a poll between the last change and time of the final call
  // -------------------------------------------------------------------------
  const updateCurrentTranscriptSession = (node) => {
    const index = CACHE.findIndex((el) => el.node === node);

    if (index === -1) {
      const currentSpeakerIndex = increment(makeTranscriptKey(currentTranscriptId, currentSessionIndex));
      CACHE.unshift({
        ...getCaptionData(node),
        startedAt: new Date(),
        endedAt: new Date(),
        node,
        count: 0,
        pollCount: 0,
        transcriptId: currentTranscriptId,
        sessionIndex: currentSessionIndex,
        speakerIndex: currentSpeakerIndex,
      });
      setSpeaker(CACHE[0]);
    } else {
      const cache = CACHE[index];

      if (cache.debounce) {
        clearInterval(cache.debounce);
      }

      cache.count += 1;
      cache.endedAt = new Date();

      cache.debounce = setInterval(
        tryTo(() => {
          cache.text = getCaptionData(node).text;
          // debug('count', cache.count, 'polls', cache.pollCount);
          setSpeaker(cache);
          clearInterval(cache.debounce);
          clearInterval(cache.poll);
          delete cache.poll;
        }, 'trailing caption poll'),
        1000
      );

      if (!('poll' in cache)) {
        cache.poll = setInterval(
          tryTo(() => {
            cache.pollCount += 1;
            cache.text = getCaptionData(node).text;
            // debug('count', cache.count, 'polls', cache.pollCount);
            setSpeaker(cache);
          }, 'caption polling'),
          1000
        );
      }
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // Captions element location and observation
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Locate captions container in the DOM and attach an observer
  //
  // Strategy for finding the node for Google's closed captions:
  //
  // 1. find all img nodes from googleusercontent.com
  // 2. partition img nodes by class
  // 3. for each class, compute lowest common ancescestor of the first two
  //    nodes
  // 4. check that it is the lowest common ancestor for rest of class
  // 5. check that each node within the class has a sibling/nephew that is a
  //    leaf node with text
  // 6. check that node is centered or starts in the bottom left corner and
  //    ends between 40-90% to the right
  // -------------------------------------------------------------------------
  const findCaptionsContainer = () => {
    captionContainerChildObserver.disconnect();
    captionContainerAttributeObserver.disconnect();

    const nodesByClass = {};

    const nodes = Array.from(document.querySelectorAll('img')).filter((node) => {
        return node.src.match(/\.googleusercontent\.com\//);
    });

    for (let node of nodes) {
      if (!(node.clasName in nodesByClass)) {
        nodesByClass[node.className] = [];
      }

      nodesByClass[node.className].push(node);
    }

    const candidates = [];

    for (let classNodes of Object.values(nodesByClass)) {
      let matches = 0;

      for (let node of classNodes) {
        const spans = document.evaluate(`..//span`, node.parentElement, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);

        let span;

        while (span = spans.iterateNext()) {
          if (span.children.length === 0 && span.textContent.length > 3) {
            matches += 1;
            break;
          }
        }
      }

      if (matches !== classNodes.length) {
        continue;
      }

      let candidate = null;

      if (classNodes.length >= 2) {
        const nodeCopy = [...classNodes];
        let current = null;
        let noSharedCommonAncestor = false;

        do {
          for (let i in nodeCopy) {
            if (!nodeCopy[i].parent) {
              noSharedCommonAncestor = true;
              break;
            }

            nodeCopy[i] = nodeCopy[i].parent;

            if (i === 0) {
              current = nodeCopy[i];
            } else if (current && current !== nodeCopy[i]) {
              current = null;
            }
          }
        } while (current === null && noSharedCommonAncestor === false);

        candidate = current;

      } else {
        let node = classNodes[0];

        while (candidate === null && node) {
          if (node.getAttribute('jscontroller')) {
            candidate = node;
          } else {
            node = node.parentNode;
          }
        }
      }

      if (candidate) {
        const windowWidth = window.innerWidth;

        const rect = candidate.children[0].getBoundingClientRect();
        const isCentered = Math.abs(rect.x - rect.left) < 10;
        const isThreeFifthsWidth = Math.abs((rect.x + rect.left)*3/2 - rect.width) < 10;

        const isLeftAligned = rect.left < (windowWidth * .2);
        const isNotRightAligned = rect.right < (windowWidth * .9);
        const isWiderThanHalf = rect.right > (windowWidth * .5);

        // NOTE: could be more precise about location
        // NOTE: could explore factors that lead one of these situations to be
        //       true and then only accept candidates matching the expected case

        if (isCentered && isThreeFifthsWidth ||
            isLeftAligned && isNotRightAligned && isWiderThanHalf) {
          candidates.push(candidate);
        }
      }
    }

    // return candidates.length === 1 ? candidates[0] : null;

    if (candidates.length === 1) {
      captionContainerChildObserver.observe(candidates[0], {
        childList: true,
        subtree: true,
        // not used
        // characterData: true,
        // characterDataOldValue: true,
      });

      captionContainerAttributeObserver.observe(candidates[0], {
        attributes: true,
        subtree: false,
        attributeOldValue: true,
      });

      Array.from(candidates[0].children).forEach(tryTo((child) => {
        updateCurrentTranscriptSession(child);
      }, 'handling child node'));

      return candidates[0];
    }
  }

  // -------------------------------------------------------------------------
  // Define MutationObserver to observe the caption container
  //
  // NOTE: not a function
  // -------------------------------------------------------------------------
  const captionContainerChildObserver = new MutationObserver(tryTo((mutations) => {
    for (let mutation of mutations) {
      if (mutation.target === captionsContainer) {
        for (let node of mutation.addedNodes) {
          updateCurrentTranscriptSession(node);
        }

        // for (let node of mutation.removedNodes) {
        //   updateCurrentTranscriptSession(node);
        // }
      } else {
        const addedSpans = Array.from(mutation.addedNodes).filter((node) => {
          return node.nodeName === 'SPAN' && node.children && node.children.length === 0;
        });

        const removedSpans = Array.from(mutation.removedNodes).filter((node) => {
          return node.nodeName === 'SPAN' && node.children && node.children.length === 0;
        });

        if (addedSpans.length > 0 || removedSpans.length > 0) {
          let node = mutation.target;

          while (node && node.parentNode !== captionsContainer) {
            node = node.parentNode;
          }

          if (!node) {
            debug('could not find root for', mutation.target);
            continue;
          }

          updateCurrentTranscriptSession(node);
        }
      }
    }
  }, 'executing observer'));

  // -------------------------------------------------------------------------
  // Define MutationObserver to observe the caption container's style
  // attribute
  //
  // NOTE: not a function
  // -------------------------------------------------------------------------
  const captionContainerAttributeObserver = new MutationObserver(tryTo((mutations) => {
    for (let mutation of mutations) {
      if (mutation.attributeName === 'style') {
        const style = mutation.target.getAttribute('style');
        if (mutation.oldValue === 'display: none;' && style === '') {
          // set this to null to force it to increment
          currentSessionIndex = null;
        }
      }
    }
  }, 'executing observer'));

  // -------------------------------------------------------------------------
  // Attach to captions container 1x
  //
  // Continually attempt to locate and observe the closed captions element.
  // This needs to be re-run even after successfully attaching the user can
  // disable and re-enable closed captioning.
  // -------------------------------------------------------------------------
  const closedCaptionsAttachLoop = () => {
    // TODO avoid re-attaching tot he same container
    captionsContainer = findCaptionsContainer();

    debug('attached to closed captions');

    // In my experience, I haven't seen the captions container disappear but it could if
    // the user disables and re-enables captions again.
    if (captionsContainer) {
      clearInterval(closedCaptionsAttachInterval);
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // Button
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Find the button container in the DOM
  // -------------------------------------------------------------------------
  const findButtonContainer = () => {
    const participantsIcon = xpath(XPATH_SELECTOR_PARTICIPANTS, document);
    const chatIcon = xpath(XPATH_SELECTOR_CHAT, document);
    return getCommonAncestor(participantsIcon, chatIcon);
  };


  // -------------------------------------------------------------------------
  // Add transcript button to DOM if not present repeatedly and forever
  //
  // Continually attempt to add the transcript button if hasn't been added
  // yet. This needs to be re-run because people can join/leave meetings
  // without reloading the page.
  // -------------------------------------------------------------------------
  const addButtonLoop = () => {
    const buttons = findButtonContainer();

    if (buttons && !buttons.__gmt_button_added) {
      buttons.__gmt_button_added = true;

      // Find the button container element and copy the divider
      buttons.prepend(buttons.children[1].cloneNode());

      // Add our button to to enable/disable the grid
      const toggleButton = document.createElement('div');
      toggleButton.classList = buttons.children[1].classList;
      toggleButton.classList.add('__gmt-button');
      // TODO can this be moved?
      toggleButton.style.display = 'flex';
      toggleButton.onclick = tryTo(toggleTranscribing, 'toggling grid');
      buttons.prepend(toggleButton);

      toggleButton.appendChild(makeSvg(SVG_TYPEWRITER, 24, 24, { id: ID_TOGGLE_BUTTON }));
      toggleButton.appendChild(makeMenu());
    }
  };

  // -------------------------------------------------------------------------
  // Enable transcription when the meet loads
  // -------------------------------------------------------------------------
  const transcribeOnBoot = () => {
    const buttons = findButtonContainer();

    if (buttons) {
      console.log('[google-meet-transcripts] begin transcription');

      toggleTranscribing();
      clearInterval(transcribeOnBootInterval);
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  // DOM Node Creation Utilities
  ////////////////////////////////////////////////////////////////////////////

  // -------------------------------------------------------------------------
  // Make a generic element with text and an optional onclick event
  // -------------------------------------------------------------------------
  const makeElement = (type, text, options = {}) => {
    const el = document.createElement(type);
    el.innerText = text;
    el.onclick = options.onclick ? options.onclick : null;
    return el;
  };

  // -------------------------------------------------------------------------
  // Make an SVG element with adjustable viewBox, path.d, dimmensions, id
  // and className
  // -------------------------------------------------------------------------
  const makeSvg = ({ viewBoxWidth, viewBoxHeight, pathD }, widthPx, heightPx, options = {}) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.width = `${widthPx}px`;
    svg.style.height = `${heightPx}px`;
    svg.setAttribute('viewBox', `0 0 ${viewBoxWidth} ${viewBoxHeight}`);
    svg.innerHTML = `<path d="${pathD}" class="" />`;

    svg.id = options.id ? options.id : '';
    // svg.className = options.className ? options.className : '';
    if (options.className) {
      svg.classList.add(options.className);
    }
    svg.onclick = options.onclick ? options.onclick : null;

    return svg;
  };

  // -------------------------------------------------------------------------
  // Make a menu with primary actions and a list of transcripts
  // -------------------------------------------------------------------------
  const makeMenu = () => {
    // Add checkboxes for all our additional options
    const additionalOptions = document.createElement('div');
    additionalOptions.onclick = e => e.stopPropagation();

    // TODO move
    const copyTranscript = () => navigator.clipboard.writeText(getTranscript(currentTranscriptId));
    const clearTranscript = () => deleteTranscript(currentTranscriptId);

    [
      makeMenuOption(SVG_COPY, 10, 12, 'Copy transcript to clipboard', tryTo(copyTranscript, 'copying transcript')),
      makeMenuOption(SVG_RECYCLE, 12, 12, 'Clear meeting transcript', tryTo(clearTranscript, 'clearing transcript')),
      makeMenuOption(SVG_SHREDDER, 12, 12, 'Delete all trancripts', tryTo(deleteTranscripts, 'deleting all transcripts')),
      // makeMenuOption(SVG_MUTE, 15, 12, 'Hide captions while recording', () => {}),
    ].forEach((el) => additionalOptions.appendChild(el));

    const list = makeTranscriptList();

    if (list.children.length > 0) {
      additionalOptions.appendChild(document.createElement('hr'));
      additionalOptions.appendChild(list);
    }

    return additionalOptions;
  };

  // -------------------------------------------------------------------------
  // Make a menu option - a <label> with an optional onclick event
  // -------------------------------------------------------------------------
  const makeMenuOption = (iconSvg, iconWidth, iconHeight, text, fn) => {
    const option = document.createElement('label');
    // TODO find out class name
    option.appendChild(makeSvg(iconSvg, iconWidth, iconHeight, { className: '' }));
    option.appendChild(makeElement('span', text));
    option.onclick = fn;
    return option;
  };


  // -------------------------------------------------------------------------
  // List all transcripts in localStorage
  // -------------------------------------------------------------------------
  const makeTranscriptList = (node) => {
    const transcriptIds = get(KEY_TRANSCRIPT_IDS) || [];
    const list = document.createElement('ul');

    for (let id of transcriptIds) {
      const transcript = makeTranscriptListItem(id);

      if (transcript) {
        list.appendChild(transcript);
      }
    }

    return list;
  };

  const getTranscriptNameParts = (transcriptId) => {
    const name = get(`${makeTranscriptKey(transcriptId)}_name`);

    let ignore, path, year, month, day;

    try {
      [
        ignore,
        path,
        year,
        month,
        day,
      ] = transcriptId.match(/(.+)-([0-9]{4,4})-([0-9]{2,2})-([0-9]{2,2})/);
      month = parseInt(month, 10);
      day = parseInt(day, 10);
      year = parseInt(year, 10);
    } catch (e) {
      path = transcriptId;
      month = 4;
      day = 27;
      year = 2020;
    }

    return {
      name: name || path,
      year,
      month,
      day,
    };
  };

  // -------------------------------------------------------------------------
  // Make a transcript list item from localStorage data
  //
  // NOTE: don't love the tight coupling of display + data access
  // -------------------------------------------------------------------------
  const makeTranscriptListItem = (transcriptId) => {
    const {
      hasRecords,
      minTime,
      people,
      spokenDuration,
    } = getTranscriptDetails(transcriptId);

    if (!hasRecords) {
      return;
    }

    const li = document.createElement('li');
    li.id = transcriptId;

    const selectPeople = people
      .slice(0, 5)
      .map(name => `${name} ${(spokenDuration[name]/1000/60).toFixed(0)}m`);

    const personString = `${selectPeople.join(', ')}`;

    const {
      name,
      month,
      day,
    } = getTranscriptNameParts(transcriptId);

    const _saveTranscript = tryTo(() => download(transcriptId, getTranscript(transcriptId)), 'saving transcript')
    const _copyTranscript = tryTo(() => navigator.clipboard.writeText(getTranscript(transcriptId)), 'copying transcript');
    const _deleteTranscript = tryTo(() => deleteTranscript(transcriptId), 'deleting transcript');

    [
      makeSvg(SVG_COPY, 10, 12, { onclick: _saveTranscript }),
      makeElement('span', `${name} on ${month}/${day}`, { onclick: _copyTranscript, className: 'copy' }),
      makeSvg(SVG_TRASH, 18, 20, { onclick: _deleteTranscript, className: 'trash' }),
      makeElement('p', `with ${personString}`),
    ].forEach((el) => li.appendChild(el));

    return li;
  };

  ////////////////////////////////////////////////////////////////////////////
  // Save as file
  //
  // From https://gist.github.com/liabru/11263260#gistcomment-2894088
  ////////////////////////////////////////////////////////////////////////////

  const download = (filename, text) => {
    var element = document.createElement('a');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    element.setAttribute('download', filename);

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
  };

  ////////////////////////////////////////////////////////////////////////////
  // Main App
  ////////////////////////////////////////////////////////////////////////////

  console.log(`[google-meet-transcripts] localStorage version`, getOrSet('version', 1, version = LOCALSTORAGE_VERSION));
  setInterval(tryTo(addButtonLoop, 'adding button'), 1000);
  transcribeOnBootInterval = setInterval(transcribeOnBoot, 1200);

  syncSettings();

  ////////////////////////////////////////////////////////////////////////////
  // COLOR, STYLE, and SVG constants
  //
  // Moved to the bottom of the file because they're obtrusive
  ////////////////////////////////////////////////////////////////////////////

  // used for icon default
  const COLOR_GREY = '5F6368';

  // used for toggle icon when active
  const COLOR_ORANGE = 'DA3025';

  // used for delete transcript button
  const COLOR_RED = 'D19797';

  // Add stylesheet to DOM
  const STYLE = document.createElement('style')
  STYLE.innerText = `
    .__gmt-button {
      overflow: visible !important;
    }
    .__gmt-button > div {
      box-sizing: border-box;
      display: none;
      position: absolute;
      top: 40px;
      left: 0;
      width: 300px;
      padding: 12px;
      padding-bottom: 10px;
      padding-top: 18px;
      background: white;
      border-radius: 0 0 0 8px;
      text-align: left;
      cursor: auto;
    }
    .__gmt-button:hover > div {
      display: block;
    }
    .__gmt-button > div label {
      display: block;
      line-height: 24px;
      cursor: pointer;
      margin-right: 8px;
      margin-left: 8px;
    }
    .__gmt-button > div label > span {
      margin-left: 6px;
    }
    .__gmt-button > div > ul {
      list-style-type: none;
      padding: 0px;
      padding-inline-start: 0px;
      padding-inline-end: 0px;
      padding-right: 8px;
      margin-left: 8px;
      margin-right: -8px;
      margin-top: 4px;
      margin-bottom: 0px;
      max-height: 400px;
      overflow-y: scroll;
    }
    .__gmt-button > div > ul > li {
      line-height: 1em;
      position: relative;
      margin-top: 12px;
      margin-bottom: 12px;
    }
    .__gmt-button > div > ul > li > svg.copy {
      cursor: pointer;
    }
    .__gmt-button > div > ul > li > span {
      margin-left: 6px;
      cursor: pointer;
    }
    .__gmt-button > div > ul > li > svg.trash {
      display: none;
      position: absolute;
      top: 0px;
      right: 0px;
      cursor: pointer;
      fill: #${COLOR_RED};
    }
    .__gmt-button > div > ul > li:hover > svg.trash {
      display: block;
    }
    .__gmt-button > div > ul > li > p {
      padding-top:  0px;
      padding-bottom:  0px;
      margin-top: 5px;
      margin-bottom: 5px;
      font-size:  .8em;
      color: #9e9e9e;
    }

    .__gmt-button > path {
      fill: #${COLOR_GREY};
    }

    #__gmt-icon.on > path {
      fill: #${COLOR_ORANGE};
    }
  `;
  document.body.append(STYLE);

  const SVG_COPY = {
    viewBoxWidth: 448,
    viewBoxHeight: 512,
    pathD: 'M433.941 65.941l-51.882-51.882A48 48 0 0 0 348.118 0H176c-26.51 0-48 21.49-48 48v48H48c-26.51 0-48 21.49-48 48v320c0 26.51 21.49 48 48 48h224c26.51 0 48-21.49 48-48v-48h80c26.51 0 48-21.49 48-48V99.882a48 48 0 0 0-14.059-33.941zM352 32.491a15.88 15.88 0 0 1 7.431 4.195l51.882 51.883A15.885 15.885 0 0 1 415.508 96H352V32.491zM288 464c0 8.822-7.178 16-16 16H48c-8.822 0-16-7.178-16-16V144c0-8.822 7.178-16 16-16h80v240c0 26.51 21.49 48 48 48h112v48zm128-96c0 8.822-7.178 16-16 16H176c-8.822 0-16-7.178-16-16V48c0-8.822 7.178-16 16-16h144v72c0 13.2 10.8 24 24 24h72v240z',
  };

  const SVG_RECYCLE = {
    viewBoxWidth: 512,
    viewBoxHeight: 512,
    pathD: 'M214.951 71.068l-29.543 48.77c-3.425 5.654-10.778 7.473-16.444 4.069l-20.562-12.355c-5.694-3.422-7.525-10.819-4.085-16.501l29.585-48.861c37.33-61.594 126.877-61.579 164.198 0l44.115 72.856 34.93-20.988c12.268-7.371 27.19 3.858 23.765 17.585l-21.886 87.815c-2.137 8.574-10.821 13.792-19.395 11.654l-87.804-21.906c-13.822-3.446-16.55-21.921-4.37-29.239l33.631-20.208-44.045-72.707c-18.636-30.747-63.456-30.73-82.09.016zM55.006 335.104l49.596-81.873 34.03 20.447c12.18 7.318 27.211-3.763 23.765-17.585l-21.88-87.811c-2.137-8.574-10.821-13.792-19.395-11.654l-87.81 21.902c-13.729 3.421-16.638 21.868-4.37 29.239l34.554 20.762-49.475 81.711C-24.729 374.181 21.448 456 96.12 456H164c6.627 0 12-5.373 12-12v-24c0-6.627-5.373-12-12-12H96.045c-37.259 0-60.426-40.907-41.039-72.896zm442.98-24.861l-34.991-57.788c-3.424-5.655-10.778-7.476-16.445-4.071l-20.53 12.336c-5.695 3.422-7.526 10.821-4.083 16.504l35.074 57.897C476.323 366.988 453.337 408 415.96 408H320v-39.98c0-14.21-17.24-21.386-27.313-11.313l-64 63.98c-6.249 6.248-6.249 16.379 0 22.627l64 63.989C302.689 517.308 320 510.3 320 495.989V456h95.887c74.764 0 120.802-81.898 82.099-145.757z',
  };

  const SVG_SHREDDER = {
    viewBoxWidth: 512,
    viewBoxHeight: 512,
    pathD: 'M432 192h-16v-82.75c0-8.49-3.37-16.62-9.37-22.63L329.37 9.37c-6-6-14.14-9.37-22.63-9.37H126.48C109.64 0 96 14.33 96 32v160H80c-44.18 0-80 35.82-80 80v96c0 8.84 7.16 16 16 16h480c8.84 0 16-7.16 16-16v-96c0-44.18-35.82-80-80-80zM320 45.25L370.75 96H320V45.25zM128.12 32H288v64c0 17.67 14.33 32 32 32h64v64H128.02l.1-160zM480 352H32v-80c0-26.47 21.53-48 48-48h352c26.47 0 48 21.53 48 48v80zm-80-88c-13.25 0-24 10.74-24 24 0 13.25 10.75 24 24 24s24-10.75 24-24c0-13.26-10.75-24-24-24zM48 504c0 4.42 3.58 8 8 8h16c4.42 0 8-3.58 8-8v-88H48v88zm96 0c0 4.42 3.58 8 8 8h16c4.42 0 8-3.58 8-8v-88h-32v88zm96 0c0 4.42 3.58 8 8 8h16c4.42 0 8-3.58 8-8v-88h-32v88zm96 0c0 4.42 3.58 8 8 8h16c4.42 0 8-3.58 8-8v-88h-32v88zm96 0c0 4.42 3.58 8 8 8h16c4.42 0 8-3.58 8-8v-88h-32v88z',
  };

  const SVG_TRASH = {
    viewBoxWidth: 448,
    viewBoxHeight: 512,
    pathD: 'M296 432h16a8 8 0 0 0 8-8V152a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v272a8 8 0 0 0 8 8zm-160 0h16a8 8 0 0 0 8-8V152a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v272a8 8 0 0 0 8 8zM440 64H336l-33.6-44.8A48 48 0 0 0 264 0h-80a48 48 0 0 0-38.4 19.2L112 64H8a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8h24v368a48 48 0 0 0 48 48h288a48 48 0 0 0 48-48V96h24a8 8 0 0 0 8-8V72a8 8 0 0 0-8-8zM171.2 38.4A16.1 16.1 0 0 1 184 32h80a16.1 16.1 0 0 1 12.8 6.4L296 64H152zM384 464a16 16 0 0 1-16 16H80a16 16 0 0 1-16-16V96h320zm-168-32h16a8 8 0 0 0 8-8V152a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v272a8 8 0 0 0 8 8z',
  };

  const SVG_TYPEWRITER = {
    viewBoxWidth: 512,
    viewBoxHeight: 512,
    pathD: 'M312 384h16a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8zm64 0h16a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8zm-256 0h16a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8zm360-192h-32v-82.73a32.07 32.07 0 0 0-9.38-22.65L361.38 9.38A32 32 0 0 0 338.75 0H112a48 48 0 0 0-48 48v144H32a32 32 0 0 0-32 32v64a32 32 0 0 0 32 32v128a64 64 0 0 0 64 64h320a64 64 0 0 0 64-64V320a32 32 0 0 0 32-32v-64a32 32 0 0 0-32-32zM352 45.25L402.75 96H352zM96 48a16 16 0 0 1 16-16h208v64a32 32 0 0 0 32 32h64v64h-50.75a32 32 0 0 0-22.62 9.37l-13.26 13.26a32 32 0 0 1-22.62 9.37h-101.5a32 32 0 0 1-22.62-9.37l-13.26-13.26a32 32 0 0 0-22.62-9.37H96zm352 400a32 32 0 0 1-32 32H96a32 32 0 0 1-32-32V320h384zm32-160H32v-64h114.75L160 237.25A63.58 63.58 0 0 0 205.25 256h101.5A63.58 63.58 0 0 0 352 237.25L365.25 224H480zM144 440a8 8 0 0 0 8 8h208a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8H152a8 8 0 0 0-8 8zm40-56h16a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8zm64 0h16a8 8 0 0 0 8-8v-16a8 8 0 0 0-8-8h-16a8 8 0 0 0-8 8v16a8 8 0 0 0 8 8z',
  };

  const SVG_MUTE = {
    viewBoxWidth: 640,
    viewBoxHeight: 512,
    pathD: 'M634 471L36 3.5C29.1-2 19-.9 13.5 6l-10 12.5C-2 25.4-.9 35.5 6 41l58 45.3 41.6 32.5L604 508.5c6.9 5.5 17 4.4 22.5-2.5l10-12.5c5.5-6.9 4.4-17-2.5-22.5zM512 48c8.8 0 16 7.2 16 16v263.2l46.8 36.6c.7-3.8 1.2-7.8 1.2-11.8V64c0-35.3-28.7-64-64-64H128c-5.5 0-10.7.9-15.8 2.2L170.8 48H512zM339.2 377.6L272 428v-60H128c-8.8 0-16-7.2-16-16V184.8l-48-37.5V352c0 35.3 28.7 64 64 64h96v84c0 7.1 5.8 12 12 12 2.4 0 4.9-.7 7.1-2.4L368 416h39.8l-58.6-45.8-10 7.4z',
  };

  const XPATH_SELECTOR_PARTICIPANTS = `//div[@aria-label='Show everyone']//*[@d='M15 8c0-1.42-.5-2.73-1.33-3.76.42-.14.86-.24 1.33-.24 2.21 0 4 1.79 4 4s-1.79 4-4 4c-.43 0-.84-.09-1.23-.21-.03-.01-.06-.02-.1-.03A5.98 5.98 0 0 0 15 8zm1.66 5.13C18.03 14.06 19 15.32 19 17v3h4v-3c0-2.18-3.58-3.47-6.34-3.87zM9 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2m0 9c-2.7 0-5.8 1.29-6 2.01V18h12v-1c-.2-.71-3.3-2-6-2M9 4c2.21 0 4 1.79 4 4s-1.79 4-4 4-4-1.79-4-4 1.79-4 4-4zm0 9c2.67 0 8 1.34 8 4v3H1v-3c0-2.66 5.33-4 8-4z']`;

  const XPATH_SELECTOR_CHAT = `//div[@aria-label='Chat with everyone']//*[@d='M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H4V4h16v12z']`;
})();

} catch (e) {
  console.error('init error', e);
}
