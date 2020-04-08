#!/usr/bin/perl

my $doc = "<html><head><meta charset='UTF-8'></head><body><table>\n";

opendir(DIR, '.') || die $!;
@files = readdir(DIR);


#foreach $entry (sort {(stat($a))[9] <=> (stat($b))[9]} @files) {
foreach $entry (sort {(split('-',$a))[4] <=> (split('-',$b))[4]} @files) {
  if ($entry =~ /\.svg$/) {
    $date = localtime((split('-',$entry))[4]/1000);
    $doc .= "<tr><td>".(++$i).".</td><td><a href='$entry'>$entry</a></td><td>$date</td></tr>\n";
  }
}
closedir(DIR);
$doc .= "</table></body></html>\n";

print $doc;
