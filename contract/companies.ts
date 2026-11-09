// Company directory: the household-name companies Element tags cards with (the SEC watch list in
// ingest/src/config.ts, one row per ticker). Single source for the core.companies seed in
// supabase/migrations/20261115000000_companies.sql (written by scripts/gen-companies-sql.mjs; the
// ingest test companies.test.ts fails when the two drift). CIKs and exchanges are not typed here:
// the generator copies them from SEC's company_tickers_exchange.json fixture (public domain).
//
// Matching rules (contract/companyMatch.ts and core.match_companies, kept identical):
//   aliases   match on their own: exact case, whole words ("Microsoft", "Apple Inc").
//   context   ambiguous names ("Apple", "Ford", "Target"): count only when a cue word or a business
//             word is also in the card, and not right after another capitalised word ("Harrison Ford").
//   cues      company-specific words (iPhone, F-150) that make a context name count with more weight.
//   negatives phrases that veto every name match for that company in the card ("apple pie").
//   tickerInText  a bare ALL-CAPS ticker in the text counts ("AAPL"); off for tickers that are words.
// No prices, ever (rule 9): the directory has names and categories only.

export type CompanySector =
  | 'tech' | 'internet' | 'media' | 'telecom' | 'retail' | 'consumer' | 'restaurants'
  | 'travel' | 'autos' | 'finance' | 'health' | 'industrials' | 'energy';

/** Sector slug -> label, in the order the Companies screen shows them. */
export const COMPANY_SECTORS: { slug: CompanySector; label: string }[] = [
  { slug: 'tech', label: 'Technology' },
  { slug: 'internet', label: 'Internet & Social' },
  { slug: 'media', label: 'Media & Entertainment' },
  { slug: 'telecom', label: 'Telecom & Cable' },
  { slug: 'retail', label: 'Retail & Shopping' },
  { slug: 'consumer', label: 'Consumer Brands' },
  { slug: 'restaurants', label: 'Restaurants' },
  { slug: 'travel', label: 'Travel & Getting Around' },
  { slug: 'autos', label: 'Cars' },
  { slug: 'finance', label: 'Banks, Payments & Insurance' },
  { slug: 'health', label: 'Health Care' },
  { slug: 'industrials', label: 'Industrials & Aerospace' },
  { slug: 'energy', label: 'Energy' },
];

export interface CompanyEntry {
  ticker: string;            // watch-list ticker, upper case ("BRK-B")
  name: string;              // display name ("Apple Inc.")
  short: string;             // chip name ("Apple")
  sector: CompanySector;
  industry: string;
  aliases?: string[];
  context?: string[];
  cues?: string[];
  negatives?: string[];
  tickerInText?: boolean;    // default: ticker has 3+ letters and is not in TICKER_WORDS
}

/** Tickers that are also English words or common abbreviations: never matched bare in text. */
export const TICKER_WORDS = new Set([
  'ALL', 'AMC', 'BK', 'CAT', 'COIN', 'COST', 'DASH', 'DE', 'DECK', 'ELF', 'F', 'FIVE', 'GAP', 'GD', 'GE', 'GM', 'HD', 'HON',
  'HOOD', 'ICE', 'LOW', 'M', 'MA', 'MAR', 'META', 'NOW', 'PG', 'PINS', 'SNAP', 'T', 'TRU', 'V', 'W', 'WING', 'YUM', 'Z', 'C', 'MS', 'GS', 'KO',
  'MU', 'MMM', 'UPS', 'CVS', 'IBM', 'AMD', 'PNC', 'STT', 'CME', 'BA', 'KR', 'DG', 'TGT', 'UAL', 'AAL', 'LUV', 'ALK', 'DAL', 'CCL',
  'RTX', 'USB', 'XYZ', 'CRM', 'DIS', // RTX graphics cards, USB cables, 'XYZ' placeholders, CRM software, 'DIS' in all-caps text
]);

function c(ticker: string, name: string, short: string, sector: CompanySector, industry: string, extra: Omit<CompanyEntry, 'ticker' | 'name' | 'short' | 'sector' | 'industry'> = {}): CompanyEntry {
  return { ticker, name, short, sector, industry, ...extra };
}

export const COMPANIES: CompanyEntry[] = [
  // ---- Technology -------------------------------------------------------------------------
  c('AAPL', 'Apple Inc.', 'Apple', 'tech', 'Consumer electronics', {
    aliases: ['Apple Inc'], context: ['Apple'],
    cues: ['iPhone', 'iPhones', 'iPad', 'MacBook', 'App Store', 'Apple Watch', 'Apple Music', 'Apple TV', 'Apple Pay', 'AirPods', 'Vision Pro', 'iOS', 'Tim Cook', 'Cupertino'],
    negatives: ['Big Apple', 'apple pie', 'apple cider', 'apple orchard', 'apple orchards', 'apple harvest', 'apple growers', 'apple juice', 'candy apple', 'crab apple', 'Apple Valley', 'Apple River', 'apple crop', 'apple farmers'],
  }),
  c('MSFT', 'Microsoft Corp.', 'Microsoft', 'tech', 'Software & cloud', { aliases: ['Microsoft', 'Xbox', 'LinkedIn'], cues: ['Windows', 'Azure', 'Satya Nadella'] }),
  c('NVDA', 'Nvidia Corp.', 'Nvidia', 'tech', 'Chips', { aliases: ['Nvidia', 'NVIDIA'], cues: ['Jensen Huang', 'GPUs', 'GeForce'] }),
  c('GOOGL', 'Alphabet Inc.', 'Google', 'tech', 'Search & cloud', {
    aliases: ['Google', 'YouTube', 'Waymo', 'Alphabet Inc'], context: ['Alphabet'],
    cues: ['Google', 'Sundar Pichai', 'Android', 'Gemini', 'Chrome'], negatives: ['alphabet soup'],
  }),
  c('ADBE', 'Adobe Inc.', 'Adobe', 'tech', 'Software', { aliases: ['Adobe'], cues: ['Photoshop', 'Acrobat'], negatives: ['adobe house', 'adobe homes', 'adobe brick'] }),
  c('CRM', 'Salesforce, Inc.', 'Salesforce', 'tech', 'Software', { aliases: ['Salesforce'], cues: ['Marc Benioff', 'Slack'] }),
  c('ORCL', 'Oracle Corp.', 'Oracle', 'tech', 'Software & cloud', {
    aliases: ['Oracle Corp'], context: ['Oracle'], cues: ['Larry Ellison', 'database', 'cloud', 'data centers', 'data center', 'TikTok'],
    negatives: ['Oracle of Omaha', 'oracle at Delphi', 'Oracle at Delphi'],
  }),
  c('INTC', 'Intel Corp.', 'Intel', 'tech', 'Chips', {
    aliases: ['Intel Corp'], context: ['Intel'], cues: ['chips', 'chipmaker', 'semiconductor', 'semiconductors', 'foundry', 'processors', 'Lip-Bu Tan', 'Pat Gelsinger'],
  }),
  c('AMD', 'Advanced Micro Devices', 'AMD', 'tech', 'Chips', { aliases: ['AMD', 'Advanced Micro Devices'], cues: ['Lisa Su', 'chips'] }),
  c('QCOM', 'Qualcomm Inc.', 'Qualcomm', 'tech', 'Chips', { aliases: ['Qualcomm', 'Snapdragon'] }),
  c('AVGO', 'Broadcom Inc.', 'Broadcom', 'tech', 'Chips', { aliases: ['Broadcom'], cues: ['VMware'] }),
  c('IBM', 'IBM', 'IBM', 'tech', 'Software & services', { aliases: ['IBM', 'International Business Machines'] }),
  c('DELL', 'Dell Technologies', 'Dell', 'tech', 'Computers', { aliases: ['Dell Technologies'], context: ['Dell'], cues: ['laptops', 'PCs', 'servers', 'Alienware'] }),
  c('NOW', 'ServiceNow, Inc.', 'ServiceNow', 'tech', 'Software', { aliases: ['ServiceNow'] }),
  c('CSCO', 'Cisco Systems', 'Cisco', 'tech', 'Networking', { aliases: ['Cisco', 'Cisco Systems'], cues: ['Webex'] }),
  c('TXN', 'Texas Instruments', 'Texas Instruments', 'tech', 'Chips', { aliases: ['Texas Instruments'] }),
  c('AMAT', 'Applied Materials', 'Applied Materials', 'tech', 'Chip equipment', { aliases: ['Applied Materials'] }),
  c('MU', 'Micron Technology', 'Micron', 'tech', 'Memory chips', { aliases: ['Micron', 'Micron Technology'], negatives: ['micron filter'] }),
  c('LRCX', 'Lam Research', 'Lam Research', 'tech', 'Chip equipment', { aliases: ['Lam Research'] }),
  c('KLAC', 'KLA Corp.', 'KLA', 'tech', 'Chip equipment', { aliases: ['KLA Corp', 'KLA Corporation'] }),
  c('ADI', 'Analog Devices', 'Analog Devices', 'tech', 'Chips', { aliases: ['Analog Devices'] }),
  c('PANW', 'Palo Alto Networks', 'Palo Alto Networks', 'tech', 'Cybersecurity', { aliases: ['Palo Alto Networks'] }),
  c('CRWD', 'CrowdStrike Holdings', 'CrowdStrike', 'tech', 'Cybersecurity', { aliases: ['CrowdStrike'] }),
  c('PLTR', 'Palantir Technologies', 'Palantir', 'tech', 'Software', { aliases: ['Palantir'] }),
  c('INTU', 'Intuit Inc.', 'Intuit', 'tech', 'Finance software', { aliases: ['Intuit', 'TurboTax', 'QuickBooks', 'Credit Karma', 'Mailchimp'] }),
  c('TTWO', 'Take-Two Interactive', 'Take-Two', 'tech', 'Video games', { aliases: ['Take-Two', 'Take-Two Interactive', 'Rockstar Games', 'Grand Theft Auto'] }),
  c('RBLX', 'Roblox Corp.', 'Roblox', 'tech', 'Video games', { aliases: ['Roblox'] }),
  c('CHGG', 'Chegg, Inc.', 'Chegg', 'tech', 'Online learning', { aliases: ['Chegg'] }),
  c('COUR', 'Coursera, Inc.', 'Coursera', 'tech', 'Online learning', { aliases: ['Coursera'] }),
  c('DUOL', 'Duolingo, Inc.', 'Duolingo', 'tech', 'Online learning', { aliases: ['Duolingo'] }),

  // ---- Internet & Social ------------------------------------------------------------------
  c('META', 'Meta Platforms', 'Meta', 'internet', 'Social media', {
    aliases: ['Meta Platforms', 'Facebook', 'Instagram', 'WhatsApp'], context: ['Meta'], cues: ['Mark Zuckerberg', 'Zuckerberg', 'Threads', 'Quest headset'], negatives: ['meta-analysis'],
  }),
  c('SNAP', 'Snap Inc.', 'Snap', 'internet', 'Social media', { aliases: ['Snap Inc', 'Snapchat'], context: ['Snap'], cues: ['Evan Spiegel'] }),
  c('RDDT', 'Reddit, Inc.', 'Reddit', 'internet', 'Social media', { aliases: ['Reddit'] }),
  c('PINS', 'Pinterest, Inc.', 'Pinterest', 'internet', 'Social media', { aliases: ['Pinterest'] }),
  c('MTCH', 'Match Group', 'Match Group', 'internet', 'Dating apps', { aliases: ['Match Group', 'Tinder', 'Hinge'] }),
  c('BMBL', 'Bumble Inc.', 'Bumble', 'internet', 'Dating apps', { aliases: ['Bumble'], negatives: ['bumblebee', 'bumble bee', 'bumblebees'] }),

  // ---- Media & Entertainment -------------------------------------------------------------
  c('NFLX', 'Netflix, Inc.', 'Netflix', 'media', 'Streaming', { aliases: ['Netflix'] }),
  c('DIS', 'The Walt Disney Co.', 'Disney', 'media', 'Entertainment', { aliases: ['Disney', 'Walt Disney', 'ESPN', 'Hulu', 'Pixar', 'Disney+'] }),
  c('WBD', 'Warner Bros. Discovery', 'Warner Bros. Discovery', 'media', 'Entertainment', { aliases: ['Warner Bros', 'Warner Bros. Discovery', 'HBO', 'HBO Max'] }),
  c('PSKY', 'Paramount Skydance', 'Paramount', 'media', 'Entertainment', { aliases: ['Paramount Skydance', 'Paramount Pictures', 'Paramount+', 'CBS'], context: ['Paramount'], cues: ['Skydance', 'David Ellison', 'studio'] }),
  c('ROKU', 'Roku, Inc.', 'Roku', 'media', 'Streaming', { aliases: ['Roku'] }),
  c('SIRI', 'Sirius XM Holdings', 'SiriusXM', 'media', 'Radio & audio', { aliases: ['SiriusXM', 'Sirius XM'] }),
  c('LYV', 'Live Nation Entertainment', 'Live Nation', 'media', 'Live events', { aliases: ['Live Nation', 'Ticketmaster'] }),
  c('AMC', 'AMC Entertainment', 'AMC Theatres', 'media', 'Movie theaters', {
    aliases: ['AMC Entertainment', 'AMC Theatres'], context: ['AMC'], cues: ['theaters', 'theatres', 'movie theater', 'box office', 'Adam Aron'],
    negatives: ['AMC Networks', 'The Walking Dead'],
  }),

  // ---- Telecom & Cable -------------------------------------------------------------------
  c('CMCSA', 'Comcast Corp.', 'Comcast', 'telecom', 'Cable & media', { aliases: ['Comcast', 'NBCUniversal', 'Xfinity'] }),
  c('CHTR', 'Charter Communications', 'Charter', 'telecom', 'Cable', { aliases: ['Charter Communications'] }),
  c('VZ', 'Verizon Communications', 'Verizon', 'telecom', 'Wireless', { aliases: ['Verizon'] }),
  c('T', 'AT&T Inc.', 'AT&T', 'telecom', 'Wireless', { aliases: ['AT&T'] }),
  c('TMUS', 'T-Mobile US', 'T-Mobile', 'telecom', 'Wireless', { aliases: ['T-Mobile'] }),

  // ---- Retail & Shopping -----------------------------------------------------------------
  c('AMZN', 'Amazon.com, Inc.', 'Amazon', 'retail', 'Online retail & cloud', {
    aliases: ['Amazon.com', 'Whole Foods', 'Amazon Web Services'], context: ['Amazon'],
    cues: ['AWS', 'Prime Video', 'Prime Day', 'Amazon Prime', 'Alexa', 'Jeff Bezos', 'Andy Jassy', 'Kindle', 'warehouse', 'warehouses', 'online retailer'],
    negatives: ['Amazon rainforest', 'Amazon River', 'Amazon basin', 'Brazilian Amazon', 'deforestation', 'Amazon jungle'],
  }),
  c('WMT', 'Walmart Inc.', 'Walmart', 'retail', 'Discount stores', { aliases: ['Walmart', "Sam's Club"] }),
  c('TGT', 'Target Corp.', 'Target', 'retail', 'Discount stores', {
    aliases: ['Target Corp'], context: ['Target'], cues: ['retailer', 'stores', 'store', 'shoppers', 'Brian Cornell', 'Minneapolis-based'],
    negatives: ['Target Field', 'Target Center', 'target rate', 'inflation target', 'target date', 'target-date'],
  }),
  c('COST', 'Costco Wholesale', 'Costco', 'retail', 'Warehouse clubs', { aliases: ['Costco'] }),
  c('HD', 'The Home Depot', 'Home Depot', 'retail', 'Home improvement', { aliases: ['Home Depot'] }),
  c('LOW', "Lowe's Companies", "Lowe's", 'retail', 'Home improvement', { aliases: ["Lowe's"] }),
  c('BBY', 'Best Buy Co.', 'Best Buy', 'retail', 'Electronics stores', { aliases: ['Best Buy'] }),
  c('KR', 'The Kroger Co.', 'Kroger', 'retail', 'Grocery', { aliases: ['Kroger'] }),
  c('DG', 'Dollar General', 'Dollar General', 'retail', 'Discount stores', { aliases: ['Dollar General'] }),
  c('DLTR', 'Dollar Tree', 'Dollar Tree', 'retail', 'Discount stores', { aliases: ['Dollar Tree'] }),
  c('TJX', 'The TJX Companies', 'TJX', 'retail', 'Off-price stores', { aliases: ['TJX', 'TJ Maxx', 'T.J. Maxx', 'Marshalls', 'HomeGoods'] }),
  c('ROST', 'Ross Stores', 'Ross', 'retail', 'Off-price stores', { aliases: ['Ross Stores', 'Ross Dress for Less'] }),
  c('GAP', 'Gap Inc.', 'Gap', 'retail', 'Clothing', {
    aliases: ['Gap Inc', 'Old Navy', 'Banana Republic', 'Athleta'], context: ['Gap'], cues: ['retailer', 'stores', 'apparel', 'clothing', 'jeans'],
    negatives: ['wage gap', 'pay gap', 'gender gap', 'Gap year', 'gap year'],
  }),
  c('ANF', 'Abercrombie & Fitch', 'Abercrombie', 'retail', 'Clothing', { aliases: ['Abercrombie', 'Abercrombie & Fitch'] }),
  c('AEO', 'American Eagle Outfitters', 'American Eagle', 'retail', 'Clothing', { aliases: ['American Eagle Outfitters', 'Aerie'], context: ['American Eagle'], cues: ['jeans', 'retailer', 'stores', 'apparel'], negatives: ['bald eagle', 'bird'] }),
  c('URBN', 'Urban Outfitters', 'Urban Outfitters', 'retail', 'Clothing', { aliases: ['Urban Outfitters', 'Anthropologie', 'Free People'] }),
  c('M', "Macy's, Inc.", "Macy's", 'retail', 'Department stores', { aliases: ["Macy's", 'Bloomingdale\'s'] }),
  c('JWN', 'Nordstrom, Inc.', 'Nordstrom', 'retail', 'Department stores', { aliases: ['Nordstrom'] }),
  c('FIVE', 'Five Below', 'Five Below', 'retail', 'Discount stores', { aliases: ['Five Below'] }),
  c('ORLY', "O'Reilly Automotive", "O'Reilly", 'retail', 'Auto parts', { aliases: ["O'Reilly Automotive", "O'Reilly Auto Parts"] }),
  c('AZO', 'AutoZone, Inc.', 'AutoZone', 'retail', 'Auto parts', { aliases: ['AutoZone'] }),
  c('TSCO', 'Tractor Supply', 'Tractor Supply', 'retail', 'Farm & ranch stores', { aliases: ['Tractor Supply'] }),
  c('ETSY', 'Etsy, Inc.', 'Etsy', 'retail', 'Online marketplace', { aliases: ['Etsy'] }),
  c('EBAY', 'eBay Inc.', 'eBay', 'retail', 'Online marketplace', { aliases: ['eBay'] }),
  c('CVNA', 'Carvana Co.', 'Carvana', 'retail', 'Online car sales', { aliases: ['Carvana'] }),
  c('W', 'Wayfair Inc.', 'Wayfair', 'retail', 'Online furniture', { aliases: ['Wayfair'] }),
  c('CHWY', 'Chewy, Inc.', 'Chewy', 'retail', 'Online pet supplies', { aliases: ['Chewy Inc'], context: ['Chewy'], cues: ['pet', 'pets', 'retailer'] }),
  c('GME', 'GameStop Corp.', 'GameStop', 'retail', 'Video game stores', { aliases: ['GameStop'] }),
  c('ULTA', 'Ulta Beauty', 'Ulta', 'retail', 'Beauty stores', { aliases: ['Ulta', 'Ulta Beauty'] }),

  // ---- Consumer Brands -------------------------------------------------------------------
  c('NKE', 'Nike, Inc.', 'Nike', 'consumer', 'Sportswear', { aliases: ['Nike'], cues: ['sneakers', 'Jordan brand'] }),
  c('LULU', 'Lululemon Athletica', 'Lululemon', 'consumer', 'Sportswear', { aliases: ['Lululemon', 'lululemon'] }),
  c('CROX', 'Crocs, Inc.', 'Crocs', 'consumer', 'Footwear', { aliases: ['Crocs Inc'], context: ['Crocs'], cues: ['footwear', 'shoes', 'clogs', 'HeyDude'], negatives: ['crocodile', 'crocodiles', 'alligator', 'alligators', 'reptile'] }),
  c('DECK', 'Deckers Brands', 'Deckers', 'consumer', 'Footwear', { aliases: ['Deckers', 'Hoka', 'HOKA', 'UGG'] }),
  c('UAA', 'Under Armour', 'Under Armour', 'consumer', 'Sportswear', { aliases: ['Under Armour'] }),
  c('ELF', 'e.l.f. Beauty', 'e.l.f.', 'consumer', 'Cosmetics', { aliases: ['e.l.f.', 'e.l.f. Beauty', 'elf Beauty'] }),
  c('KO', 'The Coca-Cola Co.', 'Coca-Cola', 'consumer', 'Drinks', { aliases: ['Coca-Cola'], context: ['Coke'], cues: ['soda', 'drinks', 'beverage', 'bottler'], negatives: ['cocaine'] }),
  c('PEP', 'PepsiCo, Inc.', 'PepsiCo', 'consumer', 'Drinks & snacks', { aliases: ['PepsiCo', 'Pepsi', 'Frito-Lay', 'Gatorade', 'Doritos'] }),
  c('KDP', 'Keurig Dr Pepper', 'Keurig Dr Pepper', 'consumer', 'Drinks', { aliases: ['Keurig', 'Keurig Dr Pepper', 'Dr Pepper', 'Dr. Pepper'] }),
  c('MNST', 'Monster Beverage', 'Monster', 'consumer', 'Energy drinks', { aliases: ['Monster Beverage', 'Monster Energy'] }),
  c('CELH', 'Celsius Holdings', 'Celsius', 'consumer', 'Energy drinks', { aliases: ['Celsius Holdings'], context: ['Celsius'], cues: ['energy drink', 'energy drinks', 'drinks', 'beverage'], negatives: ['degrees Celsius', 'degrees', 'temperatures', 'heat wave', 'Fahrenheit'] }),
  c('PG', 'Procter & Gamble', 'P&G', 'consumer', 'Household products', { aliases: ['Procter & Gamble', 'P&G', 'Pampers'] }),
  c('HSY', 'The Hershey Co.', 'Hershey', 'consumer', 'Candy', { aliases: ['Hershey Co', 'Hershey Company', "Reese's"], context: ['Hershey'], cues: ['chocolate', 'candy', 'cocoa'] }),
  c('PTON', 'Peloton Interactive', 'Peloton', 'consumer', 'Fitness', { aliases: ['Peloton'] }),

  // ---- Restaurants -----------------------------------------------------------------------
  c('CMG', 'Chipotle Mexican Grill', 'Chipotle', 'restaurants', 'Fast casual', { aliases: ['Chipotle'], negatives: ['chipotle pepper', 'chipotle peppers', 'chipotle sauce'] }),
  c('SBUX', 'Starbucks Corp.', 'Starbucks', 'restaurants', 'Coffee shops', { aliases: ['Starbucks'] }),
  c('MCD', "McDonald's Corp.", "McDonald's", 'restaurants', 'Fast food', { aliases: ["McDonald's", 'McDonalds'] }),
  c('YUM', 'Yum! Brands', 'Yum Brands', 'restaurants', 'Fast food', { aliases: ['Yum Brands', 'Yum! Brands', 'Taco Bell', 'KFC', 'Pizza Hut'] }),
  c('DPZ', "Domino's Pizza", "Domino's", 'restaurants', 'Pizza', { aliases: ["Domino's", "Domino's Pizza"] }),
  c('WING', 'Wingstop Inc.', 'Wingstop', 'restaurants', 'Fast food', { aliases: ['Wingstop'] }),
  c('CAVA', 'Cava Group', 'Cava', 'restaurants', 'Fast casual', { aliases: ['Cava Group', 'CAVA'], context: ['Cava'], cues: ['restaurant', 'restaurants', 'Mediterranean', 'bowls'], negatives: ['sparkling wine', 'cava wine', 'Spanish cava', 'champagne', 'prosecco'] }),
  c('SHAK', 'Shake Shack', 'Shake Shack', 'restaurants', 'Fast casual', { aliases: ['Shake Shack'] }),
  c('DRI', 'Darden Restaurants', 'Darden', 'restaurants', 'Sit-down dining', { aliases: ['Darden', 'Olive Garden', 'LongHorn Steakhouse'], negatives: ['Darden School'] }),

  // ---- Travel & Getting Around -----------------------------------------------------------
  c('UBER', 'Uber Technologies', 'Uber', 'travel', 'Ride hailing & delivery', { aliases: ['Uber', 'Uber Eats'] }),
  c('LYFT', 'Lyft, Inc.', 'Lyft', 'travel', 'Ride hailing', { aliases: ['Lyft'] }),
  c('DASH', 'DoorDash, Inc.', 'DoorDash', 'travel', 'Food delivery', { aliases: ['DoorDash'] }),
  c('ABNB', 'Airbnb, Inc.', 'Airbnb', 'travel', 'Home rentals', { aliases: ['Airbnb'] }),
  c('BKNG', 'Booking Holdings', 'Booking', 'travel', 'Online travel', { aliases: ['Booking Holdings', 'Booking.com', 'Priceline', 'OpenTable'] }),
  c('EXPE', 'Expedia Group', 'Expedia', 'travel', 'Online travel', { aliases: ['Expedia', 'Vrbo', 'Hotels.com'] }),
  c('DAL', 'Delta Air Lines', 'Delta', 'travel', 'Airlines', {
    aliases: ['Delta Air Lines'], context: ['Delta'], cues: ['airline', 'airlines', 'flights', 'flight', 'Ed Bastian', 'Atlanta-based', 'carrier', 'passengers'],
    negatives: ['Delta variant', 'Mississippi Delta', 'river delta', 'Delta Force', 'Niger Delta', 'Nile Delta', 'Delta smelt'],
  }),
  c('UAL', 'United Airlines Holdings', 'United Airlines', 'travel', 'Airlines', { aliases: ['United Airlines'] }),
  c('AAL', 'American Airlines Group', 'American Airlines', 'travel', 'Airlines', { aliases: ['American Airlines'] }),
  c('LUV', 'Southwest Airlines', 'Southwest', 'travel', 'Airlines', { aliases: ['Southwest Airlines'] }),
  c('JBLU', 'JetBlue Airways', 'JetBlue', 'travel', 'Airlines', { aliases: ['JetBlue'] }),
  c('ALK', 'Alaska Air Group', 'Alaska Airlines', 'travel', 'Airlines', { aliases: ['Alaska Airlines', 'Alaska Air', 'Hawaiian Airlines'] }),
  c('MAR', 'Marriott International', 'Marriott', 'travel', 'Hotels', { aliases: ['Marriott'] }),
  c('HLT', 'Hilton Worldwide', 'Hilton', 'travel', 'Hotels', { aliases: ['Hilton Worldwide', 'Hilton Hotels'], context: ['Hilton'], cues: ['hotel', 'hotels', 'hotelier', 'rooms'], negatives: ['Paris Hilton'] }),
  c('CCL', 'Carnival Corp.', 'Carnival', 'travel', 'Cruises', { aliases: ['Carnival Corp', 'Carnival Cruise', 'Carnival Cruise Line'], context: ['Carnival'], cues: ['cruise', 'cruises', 'ships', 'cruise line'], negatives: ['Notting Hill', 'carnival rides', 'Rio carnival', 'Mardi Gras'] }),
  c('RCL', 'Royal Caribbean Group', 'Royal Caribbean', 'travel', 'Cruises', { aliases: ['Royal Caribbean'] }),
  c('NCLH', 'Norwegian Cruise Line Holdings', 'Norwegian Cruise Line', 'travel', 'Cruises', { aliases: ['Norwegian Cruise Line', 'Norwegian Cruise'] }),

  // ---- Cars ------------------------------------------------------------------------------
  c('TSLA', 'Tesla, Inc.', 'Tesla', 'autos', 'Electric cars', { aliases: ['Tesla'], cues: ['Elon Musk', 'Cybertruck', 'Model Y', 'Model 3', 'robotaxi'], negatives: ['Nikola Tesla', 'Tesla coil'] }),
  c('F', 'Ford Motor Co.', 'Ford', 'autos', 'Carmakers', {
    aliases: ['Ford Motor'], context: ['Ford'], cues: ['F-150', 'Mustang', 'Bronco', 'automaker', 'carmaker', 'Dearborn', 'Jim Farley', 'vehicles', 'trucks', 'pickup'],
    negatives: ['Harrison Ford', 'Gerald Ford', 'President Ford', 'Doug Ford', 'Tom Ford', 'Betty Ford', 'Ford Foundation', "Ford's Theatre", 'Ford Theatre'],
  }),
  c('GM', 'General Motors', 'GM', 'autos', 'Carmakers', {
    aliases: ['General Motors', 'Chevrolet', 'Cadillac'], context: ['GM'], cues: ['automaker', 'carmaker', 'Mary Barra', 'vehicles', 'trucks', 'Detroit'],
    negatives: ['GM crops', 'GM food', 'GM foods', 'genetically modified', 'Chevy Chase', 'Cadillac tax', 'the Cadillac of'],
  }),
  c('RIVN', 'Rivian Automotive', 'Rivian', 'autos', 'Electric cars', { aliases: ['Rivian'] }),
  c('LCID', 'Lucid Group', 'Lucid', 'autos', 'Electric cars', { aliases: ['Lucid Motors', 'Lucid Group'], context: ['Lucid'], cues: ['electric vehicle', 'EV', 'EVs', 'automaker', 'Air sedan'], negatives: ['lucid dream', 'lucid dreaming'] }),

  // ---- Banks, Payments & Insurance -------------------------------------------------------
  c('JPM', 'JPMorgan Chase & Co.', 'JPMorgan', 'finance', 'Banks', { aliases: ['JPMorgan', 'JPMorgan Chase', 'J.P. Morgan'], context: ['Chase'], cues: ['bank', 'banks', 'Jamie Dimon', 'credit card', 'Sapphire'], negatives: ['Chase Center', 'police chase', 'car chase'] }),
  c('BAC', 'Bank of America', 'Bank of America', 'finance', 'Banks', { aliases: ['Bank of America', 'BofA', 'Merrill Lynch'] }),
  c('WFC', 'Wells Fargo & Co.', 'Wells Fargo', 'finance', 'Banks', { aliases: ['Wells Fargo'] }),
  c('C', 'Citigroup Inc.', 'Citi', 'finance', 'Banks', { aliases: ['Citigroup', 'Citi', 'Citibank'] }),
  c('GS', 'Goldman Sachs Group', 'Goldman Sachs', 'finance', 'Investment banks', { aliases: ['Goldman Sachs'] }),
  c('MS', 'Morgan Stanley', 'Morgan Stanley', 'finance', 'Investment banks', { aliases: ['Morgan Stanley', 'E*Trade', 'E*TRADE'] }),
  c('SCHW', 'Charles Schwab Corp.', 'Schwab', 'finance', 'Brokers', { aliases: ['Charles Schwab', 'Schwab'], negatives: ['Klaus Schwab', 'World Economic Forum'] }),
  c('COF', 'Capital One Financial', 'Capital One', 'finance', 'Banks & cards', { aliases: ['Capital One'] }),
  c('USB', 'U.S. Bancorp', 'U.S. Bank', 'finance', 'Banks', { aliases: ['U.S. Bancorp', 'U.S. Bank', 'US Bancorp'] }),
  c('PNC', 'PNC Financial Services', 'PNC', 'finance', 'Banks', { aliases: ['PNC', 'PNC Bank', 'PNC Financial'] }),
  c('TFC', 'Truist Financial', 'Truist', 'finance', 'Banks', { aliases: ['Truist'] }),
  c('BK', 'BNY', 'BNY', 'finance', 'Banks', { aliases: ['BNY Mellon', 'Bank of New York Mellon', 'BNY'] }),
  c('STT', 'State Street Corp.', 'State Street', 'finance', 'Asset managers', { aliases: ['State Street Corp', 'State Street Global Advisors'], context: ['State Street'], cues: ['bank', 'asset manager', 'funds', 'Boston-based'] }),
  c('BLK', 'BlackRock, Inc.', 'BlackRock', 'finance', 'Asset managers', { aliases: ['BlackRock', 'iShares'], cues: ['Larry Fink'] }),
  c('V', 'Visa Inc.', 'Visa', 'finance', 'Payments', {
    aliases: ['Visa Inc'], context: ['Visa'], cues: ['payments', 'card network', 'card networks', 'credit card', 'debit card', 'Mastercard', 'swipe fees', 'transactions'],
    negatives: ['student visa', 'student visas', 'work visa', 'visa holders', 'visa rules', 'visa applicants', 'visa application', 'H-1B', 'immigration', 'embassy', 'consulate', 'travel ban', 'Visa rules', 'Visa applicants'],
  }),
  c('MA', 'Mastercard Inc.', 'Mastercard', 'finance', 'Payments', { aliases: ['Mastercard'] }),
  c('AXP', 'American Express', 'American Express', 'finance', 'Cards', { aliases: ['American Express', 'Amex'] }),
  c('PYPL', 'PayPal Holdings', 'PayPal', 'finance', 'Payments', { aliases: ['PayPal', 'Venmo'] }),
  c('XYZ', 'Block, Inc.', 'Block', 'finance', 'Payments', { aliases: ['Block Inc', 'Cash App', 'Afterpay'], cues: ['Jack Dorsey'] }),
  c('AFRM', 'Affirm Holdings', 'Affirm', 'finance', 'Buy now, pay later', { aliases: ['Affirm Holdings'], context: ['Affirm'], cues: ['buy now, pay later', 'BNPL', 'Max Levchin', 'installment', 'loans'] }),
  c('HOOD', 'Robinhood Markets', 'Robinhood', 'finance', 'Brokers', { aliases: ['Robinhood'], negatives: ['Robin Hood'] }),
  c('SOFI', 'SoFi Technologies', 'SoFi', 'finance', 'Online banks', { aliases: ['SoFi'] }),
  c('COIN', 'Coinbase Global', 'Coinbase', 'finance', 'Crypto exchanges', { aliases: ['Coinbase'] }),
  c('SLM', 'SLM Corp. (Sallie Mae)', 'Sallie Mae', 'finance', 'Student loans', { aliases: ['Sallie Mae'] }),
  c('NNI', 'Nelnet, Inc.', 'Nelnet', 'finance', 'Student loans', { aliases: ['Nelnet'] }),
  c('SYF', 'Synchrony Financial', 'Synchrony', 'finance', 'Cards', { aliases: ['Synchrony'] }),
  c('ICE', 'Intercontinental Exchange', 'ICE', 'finance', 'Exchanges', { aliases: ['Intercontinental Exchange'] }),
  c('CME', 'CME Group', 'CME Group', 'finance', 'Exchanges', { aliases: ['CME Group'] }),
  c('SPGI', 'S&P Global', 'S&P Global', 'finance', 'Ratings & data', { aliases: ['S&P Global'] }),
  c('MCO', "Moody's Corp.", "Moody's", 'finance', 'Ratings & data', { aliases: ["Moody's"] }),
  c('BRK-B', 'Berkshire Hathaway', 'Berkshire Hathaway', 'finance', 'Conglomerates', { aliases: ['Berkshire Hathaway', 'Oracle of Omaha'], cues: ['Warren Buffett', 'Greg Abel'] }),
  c('PGR', 'Progressive Corp.', 'Progressive', 'finance', 'Insurance', { aliases: ['Progressive Corp', 'Progressive Insurance'] }),
  c('ALL', 'Allstate Corp.', 'Allstate', 'finance', 'Insurance', { aliases: ['Allstate'] }),
  c('EFX', 'Equifax Inc.', 'Equifax', 'finance', 'Credit bureaus', { aliases: ['Equifax'] }),
  c('TRU', 'TransUnion', 'TransUnion', 'finance', 'Credit bureaus', { aliases: ['TransUnion'] }),
  c('FICO', 'Fair Isaac Corp.', 'FICO', 'finance', 'Credit scores', { aliases: ['FICO', 'Fair Isaac'] }),
  c('HRB', 'H&R Block', 'H&R Block', 'finance', 'Tax preparation', { aliases: ['H&R Block'] }),
  c('Z', 'Zillow Group', 'Zillow', 'finance', 'Real estate', { aliases: ['Zillow'] }),
  c('RKT', 'Rocket Companies', 'Rocket', 'finance', 'Mortgages', { aliases: ['Rocket Companies', 'Rocket Mortgage'] }),

  // ---- Health Care -----------------------------------------------------------------------
  c('CVS', 'CVS Health', 'CVS', 'health', 'Pharmacies & insurance', { aliases: ['CVS', 'CVS Health', 'Aetna'] }),
  c('UNH', 'UnitedHealth Group', 'UnitedHealth', 'health', 'Health insurance', { aliases: ['UnitedHealth', 'UnitedHealthcare', 'Optum'] }),
  c('PFE', 'Pfizer Inc.', 'Pfizer', 'health', 'Drugmakers', { aliases: ['Pfizer'] }),
  c('MRNA', 'Moderna, Inc.', 'Moderna', 'health', 'Vaccines', { aliases: ['Moderna'] }),
  c('JNJ', 'Johnson & Johnson', 'J&J', 'health', 'Drugmakers', { aliases: ['Johnson & Johnson', 'J&J'] }),
  c('LLY', 'Eli Lilly & Co.', 'Eli Lilly', 'health', 'Drugmakers', { aliases: ['Eli Lilly'], context: ['Lilly'], cues: ['Mounjaro', 'Zepbound', 'drugmaker', 'weight-loss', 'obesity drug', 'drug'] }),
  c('ABBV', 'AbbVie Inc.', 'AbbVie', 'health', 'Drugmakers', { aliases: ['AbbVie'] }),
  c('MRK', 'Merck & Co.', 'Merck', 'health', 'Drugmakers', { aliases: ['Merck'], negatives: ['Merck KGaA'] }),
  c('BMY', 'Bristol Myers Squibb', 'Bristol Myers', 'health', 'Drugmakers', { aliases: ['Bristol Myers Squibb', 'Bristol-Myers Squibb', 'Bristol Myers'] }),
  c('AMGN', 'Amgen Inc.', 'Amgen', 'health', 'Biotech', { aliases: ['Amgen'] }),
  c('GILD', 'Gilead Sciences', 'Gilead', 'health', 'Biotech', { aliases: ['Gilead', 'Gilead Sciences'], negatives: ['Handmaid'] }),
  c('HIMS', 'Hims & Hers Health', 'Hims & Hers', 'health', 'Telehealth', { aliases: ['Hims & Hers', 'Hims'] }),

  // ---- Industrials & Aerospace -----------------------------------------------------------
  c('BA', 'The Boeing Co.', 'Boeing', 'industrials', 'Aerospace', { aliases: ['Boeing'] }),
  c('LMT', 'Lockheed Martin', 'Lockheed Martin', 'industrials', 'Defense', { aliases: ['Lockheed Martin', 'Lockheed'] }),
  c('RTX', 'RTX Corp.', 'RTX', 'industrials', 'Aerospace & defense', { aliases: ['Raytheon', 'Pratt & Whitney', 'RTX Corp'], context: ['RTX'], cues: ['Raytheon', 'defense', 'missiles', 'missile', 'Pentagon', 'jet engines'], negatives: ['GeForce RTX', 'RTX 40', 'RTX 50', 'graphics card', 'graphics cards'] }),
  c('GD', 'General Dynamics', 'General Dynamics', 'industrials', 'Defense', { aliases: ['General Dynamics', 'Gulfstream'] }),
  c('NOC', 'Northrop Grumman', 'Northrop Grumman', 'industrials', 'Defense', { aliases: ['Northrop Grumman', 'Northrop'] }),
  c('HON', 'Honeywell International', 'Honeywell', 'industrials', 'Conglomerates', { aliases: ['Honeywell'] }),
  c('CAT', 'Caterpillar Inc.', 'Caterpillar', 'industrials', 'Machinery', { aliases: ['Caterpillar Inc'], context: ['Caterpillar'], cues: ['equipment', 'machinery', 'bulldozers', 'excavators', 'construction', 'mining'], negatives: ['butterfly', 'butterflies', 'moth', 'moths', 'larvae'] }),
  c('DE', 'Deere & Co.', 'John Deere', 'industrials', 'Machinery', { aliases: ['John Deere', 'Deere'] }),
  c('GE', 'GE Aerospace', 'GE Aerospace', 'industrials', 'Aerospace', { aliases: ['GE Aerospace', 'General Electric'], context: ['GE'], cues: ['jet engines', 'engines', 'aerospace', 'Larry Culp'], negatives: ['GE Vernova', 'GE HealthCare', 'GE Appliances'] }),
  c('MMM', '3M Co.', '3M', 'industrials', 'Conglomerates', { aliases: ['3M'], negatives: ['$3M', '3M users', '3M people', '3M customers', '3M subscribers', '3M views'] }),
  c('UPS', 'United Parcel Service', 'UPS', 'industrials', 'Shipping', { aliases: ['UPS', 'United Parcel Service'] }),
  c('FDX', 'FedEx Corp.', 'FedEx', 'industrials', 'Shipping', { aliases: ['FedEx'] }),

  // ---- Energy ----------------------------------------------------------------------------
  c('XOM', 'Exxon Mobil Corp.', 'Exxon', 'energy', 'Oil & gas', { aliases: ['Exxon', 'ExxonMobil', 'Exxon Mobil'] }),
  c('CVX', 'Chevron Corp.', 'Chevron', 'energy', 'Oil & gas', { aliases: ['Chevron'], negatives: ['Chevron deference', 'Chevron doctrine', 'Chevron ruling', 'Chevron precedent'] }),
];

/** true when a bare ALL-CAPS ticker in text counts as a mention of the company. */
export function tickerInText(e: CompanyEntry): boolean {
  if (typeof e.tickerInText === 'boolean') return e.tickerInText;
  return e.ticker.replace(/[^A-Z]/g, '').length >= 3 && !TICKER_WORDS.has(e.ticker);
}

export function sectorLabel(slug: string): string {
  return COMPANY_SECTORS.find((s) => s.slug === slug)?.label ?? slug;
}
