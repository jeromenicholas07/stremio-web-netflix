// Curated dictionary of adult terms used to power Incognito search
// suggestions. Surfaces only when the user has typed at least one
// character — never as pre-filled fillers on focus, so an empty search
// stays empty.
//
// Keep entries lowercase (matching is case-insensitive). One canonical
// form per concept — synonyms / aliases live in the same row separated
// by `|` so a single user-typed prefix can resolve to the canonical
// search term while still matching common alternatives.
//
// Format: each entry is either:
//   'plain term'                       — used as-is
//   'canonical|alias1|alias2'          — canonical comes first, aliases
//                                         match the user input but the
//                                         suggestion shows canonical
//
// The list is deliberately broad. Nothing here is "promoted"; the user
// only sees an entry once they've typed something that prefixes it.

const ADULT_DICTIONARY = [
    // ── Body type / appearance ──
    'amateur', 'asian', 'arab', 'african', 'australian', 'bbw', 'bbw mature',
    'big ass|fat ass|booty', 'big tits|big boobs|big breasts',
    'black|ebony', 'blonde', 'brunette', 'busty', 'chubby', 'curvy',
    'european', 'fit|athletic', 'flat chest', 'german', 'goth|emo',
    'hairy', 'huge tits|massive tits|enormous tits', 'indian', 'italian',
    'japanese', 'jewish', 'korean', 'latina|hispanic|spanish', 'mature|gilf',
    'middle eastern', 'milf', 'native american', 'natural tits',
    'nerd|geek|glasses', 'pawg', 'petite', 'pierced|piercing', 'pregnant',
    'puerto rican', 'redhead|ginger', 'russian', 'short hair', 'skinny|slim',
    'small tits|tiny tits', 'stepmom', 'tall', 'tattoo|inked',
    'teen|18+ teen|young', 'thai', 'thick', 'tight body', 'turkish',
    'twink', 'ukrainian', 'vietnamese', 'white',

    // ── Categories / scenarios ──
    'anal|ass fucking|backdoor', 'audition|casting|first time',
    'babysitter', 'bareback', 'bath|shower', 'bdsm|bondage|kink|kinky',
    'bedroom', 'behind the scenes|bts', 'big cock|big dick|monster cock',
    'birthday', 'blowjob|bj|oral', 'boss|secretary|office',
    'bus|train|subway', 'car|backseat', 'casting couch', 'caught|spying',
    'cheating|wife cheating|husband cheating', 'classroom|school|college',
    'clothed|fully clothed', 'club|nightclub|party', 'compilation',
    'cosplay', 'costume|halloween', 'couple', 'cowgirl|reverse cowgirl',
    'creampie|internal', 'cumshot|cum|facial', 'cunnilingus|eating pussy',
    'cute', 'date|dating', 'deepthroat|throated', 'doggy style|doggystyle',
    'double anal|double penetration|dp', 'double blowjob',
    'doctor|nurse|medical', 'dominatrix|domme', 'drunk|wasted',
    'dressing room', 'drinking', 'eating out',
    'exhibitionist|exhibition', 'face fuck|facefuck', 'face sit|facesitting',
    'family roleplay', 'feet|foot worship|foot job', 'fetish',
    'first time', 'fishnet', 'fisting', 'fitness|gym|workout|yoga',
    'forced|rough', 'french kiss|kissing', 'gangbang', 'gaping',
    'garden|outdoor|park', 'gay', 'glory hole', 'group|orgy',
    'handjob|hand job|hj', 'hardcore', 'hentai|anime|cartoon',
    'high heels|stilettos', 'home alone', 'homemade', 'hood', 'hooker',
    'horny', 'hotel', 'hot tub|jacuzzi', 'housewife', 'huge load',
    'humiliation', 'incest roleplay|step family|stepsister|stepbrother|stepson|stepdaughter|stepmom|stepdad',
    'interracial|bbc|wmaf|bmwf', 'interview', 'jav|japanese av|uncensored jav',
    'jeans|denim', 'kissing|making out', 'kitchen', 'lactation',
    'latex|leather|pvc', 'lesbian|girl on girl|gg|sapphic',
    'library', 'lingerie|stockings', 'living room', 'locker room',
    'maid|french maid', 'mainstream|movie', 'massage', 'masturbation|solo',
    'mature', 'milking', 'missionary', 'model|modeling', 'mom and son roleplay',
    'mother|mother in law', 'mouthful', 'natural', 'naughty', 'neighbor',
    'nipple play', 'no panties', 'nudist|naturist', 'nun|religious',
    'office', 'old and young', 'on top', 'oral|oral sex', 'orgasm',
    'outdoor|public', 'panties', 'pantyhose', 'parking lot', 'party',
    'piss|pissing|golden shower', 'pizza guy|delivery', 'plumber',
    'point of view|pov', 'pool|poolside', 'prison', 'public|in public',
    'punishment', 'rape roleplay|forced roleplay', 'reality',
    'reverse gangbang', 'rimjob|rimming|ass eating', 'roleplay',
    'romantic|sensual|love making', 'rough', 'school|schoolgirl|college',
    'sex tape|leaked', 'shy|nervous', 'skirt', 'sleep|sleeping',
    'small dick|sph', 'smoking', 'sneaky|cheating', 'sofa|couch',
    'spit|spitting', 'sports|cheerleader', 'squirt|squirting|female ejaculation',
    'stairs', 'stepfather', 'stepmother', 'stockings', 'strip|striptease',
    'student|teacher', 'submissive|sub', 'sucking', 'swallow|swallowing',
    'swimsuit|bikini', 'swing|swinger', 'tease|teasing', 'threesome|3some',
    'tickling', 'tied up|bondage', 'tit fuck|titty fuck|titjob',
    'toys|sex toys|dildo|vibrator', 'trans|transgender|shemale|tgirl|ladyboy',
    'tribbing|scissoring', 'truck driver', 'tutor', 'uncensored',
    'underwear', 'uniform', 'upskirt', 'used|used and abused',
    'vibrator', 'vintage|classic|retro|70s|80s|90s', 'voyeur|spy|hidden cam',
    'waitress', 'wake up', 'water sports', 'webcam|cam|live cam',
    'wedding|bride', 'whipping|spanking', 'whore', 'wife|housewife',
    'wife sharing|cuckold|hotwife', 'window', 'wine', 'workout|gym',
    'wrestling', 'yoga|yoga pants', 'young and old',

    // ── Production / quality ──
    '4k|2160p|uhd', '1080p|fullhd', '720p|hd', 'amateur quality',
    'pov 4k', 'professional', 'studio', 'vr|virtual reality|180|360',

    // ── Studios (popular ones — helps when user types a partial) ──
    'brazzers', 'reality kings', 'naughty america', 'bangbros',
    'mofos', 'digital playground', 'wicked', 'evil angel', 'jules jordan',
    'tushy', 'vixen', 'blacked', 'deeper', 'tushy raw', 'slayed',
    'kink|kink.com', 'csm|csm productions', 'vivid', 'private', 'hustler',
    'penthouse', 'playboy', 'spizoo', 'team skeet', 'mylf', 'mom xxx',
    'family strokes', 'family therapy', 'pure taboo', 'fantasy massage',
    'mom pov', 'gloryhole secrets', 'all girl massage', 'kinky family',
    'casting couch x', 'czech casting', 'female agent', 'public agent',
    'fake taxi', 'fake hospital', 'fake driving school', 'fake agent',
    'evolved fights', 'sex art', 'met art', 'x-art', 'joymii',
    'wow girls', 'nubile films', '21 sextury', 'private gold',
    'manuel ferrara', 'doghouse digital',
];

module.exports = ADULT_DICTIONARY;
