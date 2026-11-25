// The Liar, "The liar doesn't know": groups of words close enough to swap. When the liar doesn't know,
// they get another word from the real word's group (tea → coffee), so their drawing or words sit
// close to everyone else's. A word in no group gets any other word from its category.
// Every word here must be in words.js under the same category, at most once (tested).
export const DECOY_GROUPS = {
  Food: [
    'pizza, burger, sandwich, hot dog', 'noodles, spaghetti, lasagna', 'sushi, spring roll, dumpling',
    'taco, burrito, nachos', 'pancake, waffle, toast', 'donut, bagel, pretzel', 'cupcake, muffin, birthday cake, cheesecake',
    'cookie, brownie, gingerbread man', 'boiled egg, fried egg, omelette', 'sausage, steak, chicken leg, meatball',
    'french fries, potato chips, popcorn', 'ice cream cone, ice lolly, popsicle stick', 'chocolate bar, toffee, candy',
    'lollipop, cotton candy, marshmallow', 'honey jar, jam jar, peanut butter', 'butter, cheese, yogurt',
    'pudding, jelly, apple pie', 'salad, soup, rice bowl, cereal bowl, fish and chips', 'croissant, bread, cream roll',
  ],
  'Desi food': [
    'biryani, pulao, zarda', 'nihari, haleem, siri paye', 'karahi, chicken handi, korma', 'samosa, pakora, kachori, bread pakora',
    'jalebi, gulab jamun, rasmalai', 'kheer, rabri, sheer khurma', 'paratha, aloo paratha, anda paratha',
    'naan, roti, halwa puri', 'chapli kabab, shami kabab, seekh kabab', 'chicken tikka, malai boti, tandoori chicken, sajji',
    'chana chaat, fruit chaat, dahi bhalla, gol gappay', 'barfi, ladoo, sohan halwa', 'kulfi, gajar halwa',
    'raita, chutney, achar', 'papad, nimko, rusk', 'aloo gosht, keema, kofta', 'daal, saag',
    'bun kabab, shawarma, chicken roll, cream bun', 'chicken corn soup, lahori fish',
  ],
  Drinks: [
    'chai, doodh patti, karak chai, kashmiri chai', 'coffee, cappuccino, espresso', 'iced coffee, cold coffee',
    'green tea, lemon tea, ginger tea, cardamom tea', 'lassi, mango lassi', 'milkshake, mango shake, banana shake, strawberry shake',
    'lemonade, lemon soda, mint margarita', 'orange juice, apple juice, juice box', 'water bottle, matka water',
    'soda can, cola, pakola', 'smoothie, protein shake', 'hot chocolate, chocolate milk, hot soup mug', 'milk, gur wala doodh',
    'rooh afza, sharbat, falooda', 'coconut water, sugarcane juice', 'tea bag, peach iced tea', 'energy drink, bubble tea',
  ],
  'Fruit & veg': [
    'apple, pear, guava', 'mango, papaya, chikoo', 'orange, lemon, lime', 'grapes, blueberry, jamun, mulberry',
    'watermelon, melon, pumpkin', 'strawberry, cherry, lychee', 'peach, apricot, plum', 'kiwi, fig, pomegranate',
    'dates, raisin', 'almond, walnut, pistachio, cashew, peanut', 'potato, sweet potato, turnip', 'carrot, radish, beetroot',
    'tomato, capsicum, chili', 'onion, garlic, ginger', 'cucumber, eggplant, okra', 'broccoli, cauliflower',
    'cabbage, lettuce, spinach', 'corn, peas', 'olive, avocado', 'banana, pineapple, coconut',
  ],
  Animals: [
    'cat, kitten, hamster', 'dog, puppy, wolf, fox', 'lion, tiger, cheetah, leopard', 'snow leopard, polar bear',
    'elephant, rhino, hippo', 'giraffe, camel, llama', 'zebra, horse, donkey', 'monkey, gorilla, sloth',
    'bear, panda, koala', 'kangaroo, rabbit', 'cow, buffalo, bison, yak', 'goat, sheep, lamb', 'pig, warthog',
    'mouse, squirrel, meerkat, mongoose', 'deer, moose', 'crocodile, lizard, chameleon', 'snake, turtle, frog',
    'hedgehog, porcupine, armadillo', 'raccoon, skunk, beaver, otter', 'bat, anteater',
  ],
  Birds: [
    'parrot, macaw, cockatoo, toucan', 'owl, owl eyes, feather', 'eagle, hawk, falcon, vulture', 'crow, magpie, myna',
    'pigeon, dove', 'sparrow, robin, bulbul', 'peacock, turkey', 'penguin, pelican, seagull', 'flamingo, crane, stork, heron',
    'ostrich, emu, kiwi bird', 'duck, swan, goose', 'hen, rooster, chick', 'quail, partridge', 'hummingbird, kingfisher',
    'woodpecker, cuckoo', 'bird nest, bird house, birdcage',
  ],
  'Sea life': [
    'fish, sardine, goldfish', 'shark, swordfish, piranha', 'whale, blue whale, killer whale', 'dolphin, narwhal',
    'octopus, squid, jellyfish', 'crab, hermit crab, lobster', 'shrimp, sea snail', 'starfish, sea urchin, coral',
    'seahorse, eel', 'seal, sea lion, walrus', 'sea turtle, pufferfish', 'clownfish, angler fish, flying fish',
    'stingray, manta ray', 'oyster, pearl, sea shell', 'seaweed, coral reef', 'fish bowl, fishing net',
    'submarine window, scuba diver',
  ],
  Bugs: [
    'ant, termite, flea', 'bee, wasp, bumblebee', 'butterfly, moth, dragonfly', 'ladybug, beetle, firefly',
    'spider, tarantula, scorpion', 'mosquito, housefly, cicada', 'grasshopper, praying mantis, stick insect',
    'caterpillar, worm, glow worm', 'snail, slug', 'centipede, earwig, cockroach', 'spider web, cocoon',
    'beehive, honeycomb, ant hill', 'mosquito net, bug spray', 'ladybird larva, beetle swarm',
  ],
  Office: [
    'computer mouse, keyboard, sticky keyboard', 'monitor, laptop, projector', 'printer, paper shredder',
    'stapler, paper clip, rubber stamp', 'desk, office chair', 'whiteboard, marker, sticky note, pen holder',
    'calendar, wall clock', 'coffee mug, coffee machine, water cooler, vending machine', 'file folder, filing cabinet, clipboard',
    'envelope, email', 'desk lamp, office plant', 'name badge, lanyard, id card, business card', 'meeting room, standup meeting',
    'headset, webcam, video call', 'briefcase, necktie', 'spreadsheet, pie chart, bar graph, org chart',
    'payslip, salary day, promotion', 'resignation letter, job interview', 'team lunch, lunch break, team photo',
    'deadline, overtime', 'boss, intern', 'software bug, password', 'elevator, fire extinguisher, attendance machine, air conditioner, router',
  ],
  Home: [
    'sofa, rocking chair, chair', 'bed, bunk bed, cradle, charpai', 'pillow, blanket, dining table', 'cupboard, wardrobe, bookshelf',
    'floor lamp, chandelier, light bulb', 'ceiling fan, air cooler', 'television, remote control', 'carpet, doormat, prayer mat',
    'curtain, window', 'door, doorbell, door lock, house key', 'mirror, photo frame, vase', 'candle, fireplace, gas heater',
    'letter box, dustbin', 'broom, mop, bucket, vacuum cleaner', 'clothes iron, washing machine, laundry basket',
    'bathtub, shower, toilet', 'toothbrush, toothpaste, soap', 'towel, clothes hanger', 'comb, hair dryer',
    'generator, ups battery', 'switchboard, wall socket', 'stairs, water tank',
  ],
  Kitchen: [
    'cooking pot, pressure cooker, rice cooker', 'frying pan, tawa', 'kettle, teapot, thermos', 'teacup, drinking glass, measuring cup',
    'plate, bowl, mixing bowl', 'spoon, fork, knife', 'chopsticks, tongs, chimta', 'ladle, spatula, whisk, egg beater',
    'rolling pin, cutting board', 'grater, peeler, pizza cutter', 'blender, juicer, food processor', 'toaster, microwave, oven',
    'fridge, ice tray', 'stove, gas cylinder, matchbox', 'colander, sieve, dish rack', 'water jug, salt shaker',
    'tiffin box, lunch box', 'apron, oven mitt', 'can opener, bottle opener', 'mortar and pestle, garlic press, lemon squeezer',
    'kitchen sink, sponge',
  ],
  Clothing: [
    'shirt, t-shirt, kurta', 'trousers, jeans, shorts', 'dress, skirt, lehenga, saree', 'jacket, coat, raincoat',
    'sweater, hoodie, tracksuit', 'scarf, dupatta, hijab', 'gloves, socks', 'shoes, sneakers, boots',
    'sandals, slippers, peshawari chappal, khussa', 'high heels, handbag', 'cap, sun hat, woollen cap, sindhi cap', 'turban, ajrak',
    'shalwar kameez, pyjamas', 'waistcoat, sherwani', 'belt, wrist watch', 'ring, necklace, earrings', 'bracelet, bangles',
    'glasses, sunglasses', 'backpack, wallet', 'bow tie, button, zipper', 'face mask, umbrella', 'school uniform, apron dress',
  ],
  Sports: [
    'football, basketball, volleyball', 'tennis, badminton, table tennis', 'hockey, golf, polo', 'swimming, surfing, ice skating',
    'boxing, wrestling, sumo wrestling, karate, boxing gloves', 'cycling, running race, horse racing', 'skateboarding, skiing',
    'bowling, darts, archery, javelin', 'chess, ludo, carrom, snakes and ladders', 'dice, playing cards, rubik\'s cube',
    'kite flying, gilli danda, marbles', 'hopscotch, jump rope, tug of war', 'yoga, weightlifting, dumbbell, treadmill',
    'gold medal, finish line', 'stadium, goal post', 'referee, whistle', 'tennis racket, shuttlecock', 'video game, joystick',
    'see-saw, swing, slide', 'frisbee, fishing rod', 'kabaddi, high jump',
  ],
  Cricket: [
    'cricket bat, cricket ball, tape ball', 'stumps, bails, wicket', 'batting helmet, pads, batting gloves', 'umpire, third umpire, review',
    'bowler, spinner, fast bowler', 'batsman, wicketkeeper, captain', 'sixer, last ball six, helicopter shot', 'boundary, boundary rope',
    'scoreboard, stadium lights', 'pitch, crease', 'run out, clean bowled, catch', 'golden duck, hat-trick',
    'no ball, free hit, yorker', 'super over, follow on, rain delay', 'coin toss, appeal', 'world cup trophy, man of the match',
    'street cricket, net practice', 'cover drive, cricket jersey',
  ],
  Transport: [
    'car, taxi, jeep, van', 'bus, double decker bus, school van', 'truck, decorated truck, tractor', 'bicycle, scooter, motorbike',
    'rickshaw, chingchi, loader rickshaw, cycle rickshaw', 'train, metro, tram, steam engine', 'airplane, helicopter, glider',
    'ship, boat, sailboat, yacht', 'submarine, canoe, jet ski', 'ambulance, fire truck, police car', 'skateboard, cable car',
    'hot air balloon, parachute', 'tanga, camel cart, bullock cart', 'traffic light, road sign, zebra crossing',
    'petrol pump, car wash, parking lot', 'speed breaker, roundabout, toll plaza, bus stop', 'bridge, flyover, tunnel, highway',
    'flat tyre, traffic jam',
  ],
  Jobs: [
    'doctor, surgeon, dentist, nurse', 'teacher, librarian', 'police officer, traffic warden, security guard, chowkidar',
    'firefighter, soldier', 'pilot, astronaut, sailor', 'chef, baker, butcher', 'farmer, gardener, milkman',
    'engineer, architect, programmer', 'designer, artist, house painter', 'singer, dancer, actor', 'photographer, journalist, youtuber, news anchor',
    'driver, rickshaw driver, delivery rider', 'mechanic, plumber, electrician, carpenter', 'barber, tailor, cobbler',
    'postman, cleaner', 'waiter, cashier, receptionist', 'shopkeeper, banker, accountant, hr manager', 'lawyer, judge', 'scientist, pharmacist, vet',
    'cricketer, fisherman', 'magician, clown',
  ],
  Places: [
    'school, university, library', 'hospital, pharmacy', 'mosque, church, temple, graveyard', 'bank, post office',
    'airport, train station, petrol station', 'park, playground, amusement park, water park', 'zoo, aquarium, museum',
    'cinema, restaurant, dhaba, tea stall', 'hotel, wedding hall', 'shopping mall, bazaar, fruit market', 'bakery, barber shop, tailor shop',
    'police station, fire station, prison', 'factory, office building, skyscraper', 'farm, village', 'castle, palace, fort',
    'tower, lighthouse, windmill', 'beach, island', 'jungle, cave', 'gym, car showroom', 'apartment, house, hut, tent', 'dam, parliament',
  ],
  Pakistan: [
    'minar-e-pakistan, pakistan monument', 'badshahi mosque, faisal mosque', 'quaid\'s mausoleum, mazar', 'khyber pass, wagah border',
    'k2, nanga parbat, murree hills', 'hunza valley, swat valley, deosai plains', 'lahore fort, lahori gate, shalimar gardens',
    'clifton beach, karachi port, gwadar port', 'saif-ul-malook lake, attabad lake', 'mohenjo-daro, khewra salt mine',
    'pakistan flag, crescent and star', 'markhor, jasmine', 'truck art, rawalpindi bus, tonga ride', 'basant, chaand raat',
    'mango season, load shedding', 'independence day, 1992 world cup', 'sindhi ajrak, multan pottery', 'tharparkar desert, peshawar qissa khwani',
  ],
  Nature: [
    'sun, sunrise, sunset', 'moon, star', 'cloud, fog', 'rain, monsoon, puddle', 'rainbow, dew drop', 'snow, snowman, icicle',
    'lightning, thunder, storm', 'tornado, wind, hailstorm', 'volcano, mountain, hill', 'river, waterfall', 'lake, pond',
    'ocean, wave', 'tree, palm tree, coconut tree', 'flower, rose, tulip', 'sunflower, lotus, spring flowers', 'cactus, bamboo, bonsai',
    'leaf, grass, vine, autumn leaves', 'mushroom, acorn, pine cone, seed', 'forest, valley', 'desert, sand dune, heatwave',
    'rock, crystal, cliff', 'earthquake, glacier',
  ],
  Tech: [
    'smartphone, tablet, e-reader', 'smartwatch, fitness band', 'headphones, earbuds', 'bluetooth speaker, smart speaker',
    'camera, cctv camera, security camera', 'drone, robot, robot arm', 'charger, phone charger, power bank', 'usb stick, memory card, sim card, hard drive',
    'battery, low battery', 'satellite dish, antenna, mobile tower', 'vr headset, game console', 'selfie stick, tripod, ring light',
    'solar panel, calculator', 'qr code, barcode', 'wifi, gps', 'smart tv, touch screen', 'walkie-talkie, cable', 'alarm clock, electric toothbrush',
    '3d printer, printer ink', 'loading bar, notification, cursor', 'emoji, floppy disk', 'server room, laser pointer', 'graphics tablet, mouse pad, webcam cover',
  ],
  Music: [
    'guitar, electric guitar, banjo', 'piano, piano keys, harmonium', 'drum, drum kit, drumsticks', 'violin, cello', 'flute, harmonica, flute player',
    'trumpet, saxophone, bugle', 'tabla, dhol, tambourine', 'sitar, rubab, harp', 'xylophone, steel triangle', 'accordion, bagpipes',
    'microphone, karaoke', 'music note, metronome', 'concert, music festival', 'dj, boombox, loudspeaker', 'band, choir, marching band, qawwali',
    'radio, cassette', 'vinyl record, record player', 'music stand, conductor', 'headphone jack, guitar pick',
  ],
  Tools: [
    'hammer, mallet, sledgehammer', 'screwdriver, drill', 'wrench, spanner, pliers', 'saw, hacksaw', 'axe, pickaxe, crowbar',
    'shovel, rake, hoe, trowel', 'ladder, wheelbarrow', 'toolbox, tool belt', 'tape measure, spirit level', 'nail, screw, nut and bolt',
    'paintbrush, paint roller', 'flashlight, magnet, multimeter', 'rope, chain', 'padlock, duct tape', 'glue gun, staple gun',
    'sickle, pocket knife, utility knife', 'chisel, sandpaper', 'welding mask, hard hat, safety vest', 'watering can, garden hose, lawn mower',
   
  ],
  School: [
    'pencil, pen, ink pen, fountain pen', 'eraser, sharpener', 'ruler, protractor, geometry compass', 'scissors, glue stick',
    'crayon, highlighter, watercolors', 'notebook, sketchbook, book', 'globe, map, atlas', 'blackboard, chalk, slate, takhti',
    'dictionary, alphabet', 'report card, exam paper', 'homework, multiplication table', 'classroom, teacher\'s desk',
    'school bus, school trip', 'graduation cap, diploma', 'microscope, test tube, magnifying glass', 'pencil box, stationery shop',
    'easel, abacus', 'canteen, school bell', 'science fair, sports day', 'class photo, school assembly, roll number',
  ],
  Fantasy: [
    'dragon, dinosaur, sea monster', 'unicorn, centaur', 'mermaid, fairy', 'ghost, invisible man', 'vampire, werewolf',
    'zombie, mummy, skeleton', 'witch, wizard', 'genie, jinn, magic lamp', 'flying carpet, broomstick', 'superhero, ninja',
    'alien, ufo', 'monster, troll, giant, cyclops', 'pirate, cowboy, pirate ship', 'treasure chest, treasure map', 'knight, sword, shield',
    'princess, king, queen', 'crown, castle tower', 'phoenix, elf', 'magic wand, crystal ball, spell book, magic potion',
    'time machine, haunted house', 'angel, devil',
  ],
  Space: [
    'planet, alien planet', 'earth, mars, venus, mercury planet', 'saturn, jupiter, neptune, uranus', 'astronaut helmet, space suit',
    'rocket, rocket launch, launch pad', 'spaceship, flying saucer, space station', 'satellite, telescope', 'comet, meteor, asteroid, shooting star',
    'black hole, nebula', 'galaxy, milky way', 'constellation, star map', 'moon landing, mars rover', 'solar eclipse, sun rays',
    'half moon, full moon, crater', 'orbit, zero gravity, space dog',
  ],
  Celebrations: [
    'eid, eid prayer, eid card', 'ramadan, iftar, sehri, iftar table', 'moon sighting, eid moon, chand raat', 'qurbani goat, eidi',
    'mehndi, mehndi hands, dholki', 'wedding, baraat, valima, nikah', 'wedding cake, wedding stage, dancing at a wedding',
    'birthday party, surprise party, farewell party, baby shower', 'graduation, new year', 'picnic, camping, road trip, beach day',
    'fireworks, new year countdown, bonfire', 'balloon, birthday balloon, confetti', 'gift box, gift wrapping, pinata',
    'christmas tree, halloween pumpkin', 'diwali lamp, lantern, holi colours', 'party hat, birthday candles',
  ],
  Body: [
    'hand, foot', 'eye, eyebrow, wink', 'nose, ear, chin, cheek', 'mouth, lips, teeth, tongue', 'hair, ponytail, bald head',
    'beard, moustache', 'finger, thumb, toe', 'knee, elbow', 'heart, lungs, brain', 'muscle, shoulder', 'belly, stomach ache',
    'neck, wrist, ankle', 'fingernail, fingerprint, footprint', 'bone, skull, broken arm', 'braces, dimples, freckles',
    'sneeze, yawn, goosebumps', 'high five, fist bump, handshake',
  ],
  Feelings: [
    'happy, laughing, excited', 'sad, crying, worried', 'angry, grumpy, jealous', 'sleepy, tired, bored', 'surprised, scared, nervous',
    'confused, thinking', 'in love, shy, embarrassed', 'cool, proud, relaxed', 'sick, dizzy, hungry',
  ],
  Toys: [
    'teddy bear, stuffed bunny, doll', 'kite, kite string', 'yo-yo, spinning top', 'toy car, remote control car',
    'train set, toy train', 'building blocks, jigsaw puzzle, board game', 'rocking horse, dollhouse', 'puppet, finger puppet',
    'kaleidoscope, snow globe', 'water gun, soap bubbles', 'sandcastle, slime, play dough', 'origami, paper boat, paper plane',
    'knitting, gardening, photography', 'model airplane, toy robot', 'magic trick, juggling', 'rubber duck, bouncy ball',
    'action figure, toy soldier', 'piggy bank, toy phone', 'toy drum, whistle toy', 'roller skates, hula hoop', 'marble run, wind-up toy',
  ],
  Actions: [
    'sleeping, snoring, falling asleep at work', 'reading, typing, texting', 'brushing teeth, washing dishes', 'taking a selfie, waving, pointing',
    'climbing, jumping, sliding', 'walking the dog, riding a bike', 'praying, meditating, kneeling', 'painting a wall, ironing clothes',
    'eating, sneaking a snack', 'shopping, carrying bags, pushing a cart', 'digging, sweeping, watering plants', 'hugging, clapping, cheering',
    'crawling, tiptoeing, hiding, peeking', 'slipping on a banana, catching a bus, running late', 'arguing, shouting', 'whispering, bowing, saluting',
    'stretching, sweating, shivering', 'blowing candles, ringing a bell, knocking on a door',
  ],
  Symbols: [
    'arrow, check mark', 'circle, spiral', 'triangle, pyramid, cone', 'square, cube, cylinder', 'zigzag, infinity sign',
    'question mark, exclamation mark', 'peace sign, recycle sign', 'cross mark, no entry sign, warning sign', 'smiley face, thumbs up, love heart',
    'crescent, diamond, hexagon', 'dollar sign, percent sign, at sign, hashtag', 'plus sign, music symbol', 'pause button, play button, power button',
    'wifi symbol, battery icon',
  ],
};

// word → the other words in its group, per category
const DECOYS = {};
for (const [category, groups] of Object.entries(DECOY_GROUPS)) {
  const map = (DECOYS[category] = {});
  for (const g of groups) {
    const words = g.split(',').map((w) => w.trim()).filter(Boolean);
    for (const w of words) map[w] = words.filter((x) => x !== w);
  }
}

/** The close words for one word ([] when it's in no group). */
export const closeWords = (category, word) => (DECOYS[category] && DECOYS[category][word]) || [];
