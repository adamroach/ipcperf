#!/usr/bin/perl

my $doc = "<html><head><meta charset='UTF-8'></head><body><ol>\n";

opendir(DIR, '.') || die $!;
while ($entry = readdir(DIR)) {
  if ($entry =~ /\.svg$/) {
    $doc .= "<li><a href='$entry'>$entry</a></li>\n";
  }
}
closedir(DIR);
$doc .= "</ol></body></html>\n";

print $doc;
